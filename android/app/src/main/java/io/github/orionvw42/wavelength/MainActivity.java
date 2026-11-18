package io.github.orionvw42.wavelength;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.UserAgentMetadata;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Wavelength for Android.
 *
 * Two web views, like the desktop app:
 *  - the ENGINE: YouTube Music's own site, hidden, driven by the shared
 *    src/inject/bridge.js (playback, ad removal, the music catalog);
 *  - the UI: Wavelength's own app (assets/ui), which runs the shared
 *    listen-together engine (session.js / relay.js).
 * This activity passes messages between them and handles what only Android
 * can do: sign-in, background playback, media controls, sharing, updates.
 */
public class MainActivity extends Activity {
  static final String TAG = "Wavelength";
  static final String HOME = "https://music.youtube.com/";
  static final String UI_URL = "https://appassets.androidplatform.net/assets/ui/index.html";
  static final String SIGNIN_URL = "https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue="
      + "https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26app%3Ddesktop%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F";
  static MainActivity live;

  FrameLayout root;
  WebView engine, ui;
  LinearLayout signinBar;
  JavaScriptReplyProxy uiReply;
  final List<String> uiQueue = new ArrayList<>();
  final Handler main = new Handler(Looper.getMainLooper());

  String uaWebView, uaEngine, uaChromeMobile, chromeMajor = "146", chromeFull = "146.0.0.0";
  boolean signingIn, away, serviceStarted, videoShown, engineReady;
  // Calls made before the engine page is ready wait here (and are re-sent if
  // the page reloads before answering).
  final List<String> engineQueue = new ArrayList<>();

  boolean signedIn;

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    live = this;
    NowPlaying.init(this);
    getWindow().setStatusBarColor(Color.BLACK);
    getWindow().setNavigationBarColor(Color.BLACK);
    root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);
    setContentView(root);
    // Android 15+ draws edge to edge: keep clear of the system bars + keyboard.
    root.setOnApplyWindowInsetsListener((v, ins) -> {
      if (Build.VERSION.SDK_INT >= 30) {
        Insets i = ins.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
        v.setPadding(i.left, i.top, i.right, i.bottom);
      } else {
        v.setPadding(ins.getSystemWindowInsetLeft(), ins.getSystemWindowInsetTop(), ins.getSystemWindowInsetRight(), ins.getSystemWindowInsetBottom());
      }
      return ins;
    });

    buildUserAgents();
    engine = new KeepAliveWebView(this);
    ui = new KeepAliveWebView(this);
    // The player's page must never be treated as a background tab: Android's
    // WebView pauses hidden videos (music videos stopped in the background
    // while plain songs kept going) and slows its timers and network.
    if (Build.VERSION.SDK_INT >= 26) {
      engine.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
      ui.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
    }
    root.addView(engine, full());
    root.addView(ui, full());
    setupEngine();
    setupUi();
    buildSigninBar();

    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1);
    }
    if (Build.VERSION.SDK_INT >= 33) {
      getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
    }
    engine.getSettings().setUserAgentString(uaEngine);
    applyMetadata(engine, false);
    engine.loadUrl(HOME);
    ui.loadUrl(UI_URL);
    main.post(this::pump);
    handleIntent(getIntent());
    NowWidget.update(this);
  }

  /** A web view that always tells the page it's on screen (see onCreate). */
  static class KeepAliveWebView extends WebView {
    KeepAliveWebView(android.content.Context c) { super(c); }
    @Override protected void onWindowVisibilityChanged(int v) { super.onWindowVisibilityChanged(v == View.GONE && !keep() ? v : View.VISIBLE); }
    @Override protected void onVisibilityChanged(View changed, int v) { super.onVisibilityChanged(changed, View.VISIBLE); }
    static boolean keep() { return live != null && !live.isFinishing(); }
  }

  @Override
  protected void onNewIntent(Intent i) {
    super.onNewIntent(i);
    setIntent(i);
    handleIntent(i);
  }

  void handleIntent(Intent i) {
    if (i == null) return;
    if (i.getBooleanExtra("openPlayer", false)) toUi(obj("t", "openPlayer"));
    if (i.getBooleanExtra("autoplay", false)) toUi(obj("t", "action", "name", "resume", "arg", 0));
    i.removeExtra("openPlayer");
    i.removeExtra("autoplay");
  }

  static FrameLayout.LayoutParams full() { return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT); }
  int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }

  // ------------------------------------------------------------ user agents
  void buildUserAgents() {
    uaWebView = WebSettings.getDefaultUserAgent(this);
    Matcher m = Pattern.compile("Chrome/((\\d+)[\\d.]*)").matcher(uaWebView);
    if (m.find()) { chromeFull = m.group(1); chromeMajor = m.group(2); }
    // YouTube Music's streaming servers and ad-free responses behave with the
    // desktop app's (Electron-style) identity; see setupYtmSession in main.js.
    uaEngine = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Wavelength/" + versionName()
        + " Chrome/" + chromeMajor + ".0.0.0 Electron/45.3.3 Safari/537.36";
    // Google's sign-in pages refuse in-app browsers; they see mobile Chrome.
    uaChromeMobile = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chromeMajor + ".0.0.0 Mobile Safari/537.36";
  }

  static boolean isGoogleSignin(String host) {
    return host != null && (host.equals("accounts.google.com") || host.endsWith(".accounts.google.com"));
  }

  void applyMetadata(WebView w, boolean mobile) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) return;
    try {
      List<UserAgentMetadata.BrandVersion> brands = new ArrayList<>();
      brands.add(new UserAgentMetadata.BrandVersion.Builder().setBrand("Chromium").setMajorVersion(chromeMajor).setFullVersion(chromeFull).build());
      brands.add(new UserAgentMetadata.BrandVersion.Builder().setBrand(mobile ? "Google Chrome" : "Wavelength").setMajorVersion(chromeMajor).setFullVersion(chromeFull).build());
      brands.add(new UserAgentMetadata.BrandVersion.Builder().setBrand("Not_A Brand").setMajorVersion("24").setFullVersion("24.0.0.0").build());
      WebSettingsCompat.setUserAgentMetadata(w.getSettings(), new UserAgentMetadata.Builder()
          .setBrandVersionList(brands).setFullVersion(chromeFull)
          .setPlatform(mobile ? "Android" : "Windows").setPlatformVersion(mobile ? Build.VERSION.RELEASE : "15.0.0")
          .setModel(mobile ? Build.MODEL : "").setMobile(mobile).setArchitecture(mobile ? "arm" : "x86").setBitness(64).build());
    } catch (Throwable t) { Log.w(TAG, "UA metadata: " + t); }
  }

  String versionName() {
    try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "0"; }
  }

  // ------------------------------------------------------------ engine (YouTube Music)
  void setupEngine() {
    WebSettings s = engine.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setSupportMultipleWindows(false);
    if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
      WebSettingsCompat.setRequestedWithHeaderOriginAllowList(s, Collections.emptySet());
    }
    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(engine, true);
    if (BuildInfo.DEBUG) WebView.setWebContentsDebuggingEnabled(true);

    java.util.Set<String> ytm = Collections.singleton("https://music.youtube.com");
    WebViewCompat.addWebMessageListener(engine, "WLEngine", ytm, (view, message, origin, isMainFrame, reply) -> {
      if (isMainFrame) onEngineMessage(message.getData());
    });
    // Order matters: our start script, then the shared bridge.
    WebViewCompat.addDocumentStartJavaScript(engine, asset("engine/start.js"), ytm);
    WebViewCompat.addDocumentStartJavaScript(engine, "window.__wlCfg=" + bridgeCfg() + ";\n" + asset("engine/bridge.js"), ytm);

    engine.setWebChromeClient(new WebChromeClient());
    engine.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
        Uri u = req.getUrl();
        String scheme = u.getScheme() == null ? "" : u.getScheme();
        if (!scheme.equals("https") && !scheme.equals("http")) return true; // app links (intent:, vnd.youtube:)
        if (!req.isForMainFrame()) return false;
        String host = u.getHost();
        // Leaving YouTube Music outside sign-in: open in the browser.
        if (!signingIn && host != null && !host.endsWith("youtube.com") && !host.endsWith("google.com")) {
          openExternal(u.toString());
          return true;
        }
        boolean google = isGoogleSignin(host);
        String want = google ? uaChromeMobile : uaEngine;
        if (!want.equals(view.getSettings().getUserAgentString()) && "GET".equalsIgnoreCase(req.getMethod())) {
          view.getSettings().setUserAgentString(want);
          applyMetadata(view, google);
          view.loadUrl(u.toString());
          return true;
        }
        return false;
      }

      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
        // Network-level ad blocking (bridge.js removes the ads themselves).
        if (AdBlock.blocked(req.getUrl())) return new WebResourceResponse("text/plain", "utf-8", 204, "No Content", null, new ByteArrayInputStream(new byte[0]));
        return null;
      }

      @Override
      public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
        if (!url.startsWith(HOME) && NowPlaying.playing) { NowPlaying.playing = false; NowPlaying.notifyAll(false); }
        toUi(obj("t", "engine", "status", "loading", "url", url));
      }

      @Override
      public void onPageFinished(WebView view, String url) {
        checkSignin();
        if (url.startsWith(HOME)) {
          if (!signingIn && !engineReady) engine.evaluateJavascript("window.__wlRpc ? 1 : 0", v -> { if ("1".equals(v) && !engineReady) onEngineMessage("{\"t\":\"ready\"}"); });
          toUi(obj("t", "engine", "status", "loaded"));
          if (signingIn && signedIn) endSignin(true);
        }
      }

      @Override
      public void onReceivedError(WebView view, WebResourceRequest req, android.webkit.WebResourceError err) {
        if (req.isForMainFrame()) toUi(obj("t", "engine", "status", "offline", "reason", String.valueOf(err.getDescription())));
      }
    });
  }

  String bridgeCfg() {
    try {
      JSONObject c = new JSONObject();
      c.put("adblock", true);
      c.put("dataSaver", getSharedPreferences("app", MODE_PRIVATE).getBoolean("dataSaver", true));
      c.put("holdAtEnd", false);
      c.put("engineHidden", true);
      return c.toString();
    } catch (Exception e) { return "{}"; }
  }

  void onEngineMessage(String data) {
    try {
      JSONObject o = new JSONObject(data);
      String t = o.optString("t");
      if (t.equals("bridge")) {
        String type = o.optString("type");
        if (type.equals("state")) {
          JSONObject s = o.optJSONObject("data");
          if (s != null) onPlayerState(s);
          toUi(obj("t", "state", "s", s));
        } else {
          toUi(obj("t", "event", "type", type, "data", o.opt("data")));
        }
      } else if (t.equals("rpc")) {
        toUi(o);
      } else if (t.equals("ready")) {
        engineReady = true;
        for (String js : engineQueue) engine.evaluateJavascript(js, null);
        engineQueue.clear();
      } else if (t.equals("log")) {
        Log.i(TAG, "engine: " + o.optString("msg"));
      }
    } catch (Exception e) { Log.w(TAG, "engine message: " + e); }
  }

  void onPlayerState(JSONObject s) {
    NowPlaying.onState(s);
    boolean playingNow = s.optBoolean("playing");
    if (playingNow && (!serviceStarted || PlaybackService.inst == null)) startPlaybackService();
  }

  void engineCall(int id, String kind, String fn, JSONArray args) {
    String js = "window.__wlRpc && window.__wlRpc(" + id + "," + JSONObject.quote(kind) + "," + JSONObject.quote(fn) + "," + (args == null ? "[]" : args.toString()) + ")";
    main.post(() -> {
      if (!engineReady || signingIn) { if (engineQueue.size() < 200) engineQueue.add(js); return; }
      engine.evaluateJavascript(js, null);
    });
  }

  // ------------------------------------------------------------ UI (Wavelength)
  void setupUi() {
    WebSettings s = ui.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setTextZoom(100);
    ui.setBackgroundColor(Color.BLACK);
    WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
    WebViewCompat.addWebMessageListener(ui, "WLApp", Collections.singleton("https://appassets.androidplatform.net"), (view, message, origin, isMainFrame, reply) -> {
      if (!isMainFrame) return;
      uiReply = reply;
      onUiMessage(message.getData());
    });
    ui.setWebChromeClient(new WebChromeClient());
    ui.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
        return loader.shouldInterceptRequest(req.getUrl());
      }

      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
        String u = req.getUrl().toString();
        if (u.startsWith("https://appassets.androidplatform.net/")) return false;
        openExternal(u);
        return true;
      }
    });
  }

  void onUiMessage(String data) {
    try {
      JSONObject o = new JSONObject(data);
      switch (o.optString("t")) {
        case "hello": {
          JSONObject info = obj("t", "init", "version", versionName(), "model", Build.MODEL, "signedIn", signedIn,
              "android", Build.VERSION.RELEASE, "debug", BuildInfo.DEBUG,
              "lockPlayer", getSharedPreferences("app", MODE_PRIVATE).getBoolean("lockPlayer", true));
          sendUiNow(info.toString());
          for (String q : uiQueue) sendUiNow(q);
          uiQueue.clear();
          break;
        }
        case "rpc": engineCall(o.optInt("id"), o.optString("kind"), o.optString("fn"), o.optJSONArray("args")); break;
        case "cmd": engineCall(0, "cmd", o.optString("cmd"), o.optJSONArray("args")); break;
        case "signin": startSignin(); break;
        case "signout": signOut(); break;
        case "video": showVideo(o.optJSONObject("rect")); break;
        case "share": share(o.optString("text"), o.optString("title")); break;
        case "open": openExternal(o.optString("url")); break;
        case "exit": moveTaskToBack(true); break;
        case "setting":
          if (o.has("dataSaver")) getSharedPreferences("app", MODE_PRIVATE).edit().putBoolean("dataSaver", o.optBoolean("dataSaver")).apply();
          if (o.has("lockPlayer")) getSharedPreferences("app", MODE_PRIVATE).edit().putBoolean("lockPlayer", o.optBoolean("lockPlayer")).apply();
          break;
        case "queue": NowPlaying.onQueue(o); break;
        case "system": sendUiNow(systemInfo().toString()); break;
        case "fixBattery": openBatterySettings(); break;
        case "fixLock": openFullScreenSettings(); break;
        case "lockDemo": startActivity(new Intent(this, LockActivity.class).putExtra("demo", true)); break;
        case "update": Updater.install(this, o.optString("url"), o.optString("version")); break;
        case "reloadEngine": engine.loadUrl(HOME); break;
        default:
      }
    } catch (Exception e) { Log.w(TAG, "ui message: " + e); }
  }

  /** Battery / lock screen permissions, for the Settings page. */
  JSONObject systemInfo() {
    boolean battery = true, fsi = true;
    try { battery = getSystemService(android.os.PowerManager.class).isIgnoringBatteryOptimizations(getPackageName()); } catch (Exception e) { /* unknown */ }
    if (Build.VERSION.SDK_INT >= 34) fsi = getSystemService(android.app.NotificationManager.class).canUseFullScreenIntent();
    return obj("t", "system", "battery", battery, "fullScreen", fsi);
  }

  void openBatterySettings() {
    try {
      startActivity(new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
    } catch (Exception e) {
      try { startActivity(new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); } catch (Exception e2) { Log.w(TAG, "battery: " + e2); }
    }
  }

  void openFullScreenSettings() {
    try {
      if (Build.VERSION.SDK_INT >= 34) startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName())));
    } catch (Exception e) { Log.w(TAG, "fsi: " + e); }
  }

  void uiAction(JSONObject o) { toUi(o); }

  void toUi(JSONObject o) { toUi(o.toString()); }
  void toUi(String json) {
    main.post(() -> {
      if (uiReply == null) { if (uiQueue.size() < 500) uiQueue.add(json); return; }
      sendUiNow(json);
    });
  }
  void sendUiLater(JSONObject o) { toUi(o); }
  void sendUiNow(String json) {
    try { uiReply.postMessage(json); } catch (Exception e) { Log.w(TAG, "toUi: " + e); }
  }

  static JSONObject obj(Object... kv) {
    JSONObject o = new JSONObject();
    try { for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1] == null ? JSONObject.NULL : kv[i + 1]); } catch (Exception e) { /* keys are strings */ }
    return o;
  }

  // ------------------------------------------------------------ media controls
  /** From the notification, lock screen, headphones, Bluetooth. Goes through
   *  the UI so rooms stay in sync; falls back to the engine directly. */
  void mediaAction(String name, double arg) {
    main.post(() -> {
      if (uiReply != null) { toUi(obj("t", "action", "name", name, "arg", arg)); return; }
      JSONArray a = new JSONArray();
      if (name.equals("seek")) a.put(String.valueOf(arg));
      engineCall(0, "cmd", name, a);
    });
  }

  void startPlaybackService() {
    try {
      Intent i = new Intent(this, PlaybackService.class);
      if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
      serviceStarted = true;
    } catch (Exception e) { Log.w(TAG, "playback service: " + e); }
  }

  // ------------------------------------------------------------ sign-in
  void buildSigninBar() {
    signinBar = new LinearLayout(this);
    signinBar.setOrientation(LinearLayout.HORIZONTAL);
    signinBar.setGravity(Gravity.CENTER_VERTICAL);
    signinBar.setBackgroundColor(Color.parseColor("#0f0f0f"));
    signinBar.setPadding(dp(16), 0, dp(4), 0);
    TextView t = new TextView(this);
    t.setText("Sign in to YouTube Music");
    t.setTextColor(Color.WHITE);
    t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
    signinBar.addView(t, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
    Button close = new Button(this);
    close.setText("Cancel");
    close.setAllCaps(false);
    close.setOnClickListener(v -> endSignin(false));
    signinBar.addView(close);
    signinBar.setVisibility(View.GONE);
    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56));
    lp.gravity = Gravity.TOP;
    root.addView(signinBar, lp);
  }

  void startSignin() {
    signingIn = true;
    hideVideo();
    FrameLayout.LayoutParams lp = full();
    lp.topMargin = dp(56);
    engine.setLayoutParams(lp);
    engine.getSettings().setUserAgentString(uaChromeMobile);
    applyMetadata(engine, true);
    engine.loadUrl(SIGNIN_URL);
    engine.bringToFront();
    signinBar.setVisibility(View.VISIBLE);
    signinBar.bringToFront();
  }

  void endSignin(boolean ok) {
    signingIn = false;
    signinBar.setVisibility(View.GONE);
    engine.setLayoutParams(full());
    ui.bringToFront();
    if (!ok) {
      engine.getSettings().setUserAgentString(uaEngine);
      applyMetadata(engine, false);
      engine.loadUrl(HOME);
    }
    checkSignin();
    toUi(obj("t", "signin", "signedIn", signedIn));
  }

  void checkSignin() {
    String c = CookieManager.getInstance().getCookie(HOME);
    boolean now = c != null && (c.contains("SAPISID=") || c.contains("__Secure-3PAPISID="));
    if (now != signedIn) { signedIn = now; toUi(obj("t", "signin", "signedIn", signedIn)); }
    CookieManager.getInstance().flush();
  }

  void signOut() {
    CookieManager.getInstance().removeAllCookies(v -> {
      CookieManager.getInstance().flush();
      signedIn = false;
      engine.clearCache(false);
      engine.loadUrl(HOME);
      toUi(obj("t", "signin", "signedIn", false));
    });
  }

  // ------------------------------------------------------------ video
  /** Shows YouTube Music's video inside the UI's art area (CSS px rect). */
  void showVideo(JSONObject rect) {
    if (rect == null || signingIn) { hideVideo(); return; }
    float d = getResources().getDisplayMetrics().density;
    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.round((float) rect.optDouble("w") * d), Math.round((float) rect.optDouble("h") * d));
    lp.leftMargin = Math.round((float) rect.optDouble("x") * d);
    lp.topMargin = Math.round((float) rect.optDouble("y") * d);
    engine.setLayoutParams(lp);
    engine.bringToFront();
    videoShown = true;
    engine.evaluateJavascript("window.__wlVideoOnly && window.__wlVideoOnly(true)", null);
  }

  void hideVideo() {
    if (!videoShown) return;
    videoShown = false;
    engine.evaluateJavascript("window.__wlVideoOnly && window.__wlVideoOnly(false)", null);
    engine.setLayoutParams(full());
    ui.bringToFront();
  }

  // ------------------------------------------------------------ misc
  void share(String text, String subject) {
    Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
    if (subject != null && !subject.isEmpty()) i.putExtra(Intent.EXTRA_SUBJECT, subject);
    startActivity(Intent.createChooser(i, subject == null || subject.isEmpty() ? "Share" : subject));
  }

  void openExternal(String url) {
    if (url == null || !url.startsWith("https://")) return;
    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception e) { Log.w(TAG, "open: " + e); }
  }

  String asset(String name) {
    try (InputStream in = getAssets().open(name)) {
      java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
      byte[] b = new byte[16384];
      for (int r; (r = in.read(b)) > 0; ) out.write(b, 0, r);
      return out.toString(StandardCharsets.UTF_8.name());
    } catch (Exception e) { Log.e(TAG, "asset " + name + ": " + e); return ""; }
  }

  /** In the background Android slows page timers to a crawl; nudge both
   *  pages once a second so playback, Up Next and rooms keep working. */
  void pump() {
    if (away) {
      engine.evaluateJavascript("window.__wlPump && window.__wlPump()", null);
      ui.evaluateJavascript("window.__wlPump && window.__wlPump()", null);
    }
    main.postDelayed(this::pump, 1000);
  }

  void goBack() {
    if (signingIn) { if (engine.canGoBack()) engine.goBack(); else endSignin(false); return; }
    if (uiReply != null) toUi(obj("t", "back"));
    else moveTaskToBack(true);
  }

  @Override
  public void onBackPressed() { goBack(); }

  @Override
  protected void onStop() {
    super.onStop();
    away = true;
    CookieManager.getInstance().flush();
    toUi(obj("t", "visible", "on", false));
  }

  @Override
  protected void onStart() {
    super.onStart();
    away = false;
    toUi(obj("t", "visible", "on", true));
    sendUiLater(systemInfo());
    // Start the playback service now, while the app is on screen: Android
    // won't let it start later from the background, and without it the
    // phone cuts the app's internet as soon as it goes to sleep, so music
    // stopped a little after the screen went off.
    if (PlaybackService.inst == null) startPlaybackService();
  }

  @Override
  protected void onDestroy() {
    if (live == this) live = null;
    stopService(new Intent(this, PlaybackService.class));
    NowPlaying.playing = false;
    NowWidget.updateNow(this);
    engine.destroy();
    ui.destroy();
    super.onDestroy();
  }
}
