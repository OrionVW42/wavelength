package io.github.orionvw42.wavelength;

import android.animation.ArgbEvaluator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Outline;
import android.graphics.RenderEffect;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextClock;
import android.widget.TextView;

/**
 * The big lock screen player: shown over the lock screen while music plays.
 * Swipe up (or unlock) to get to the phone.
 */
public class LockActivity extends Activity implements NowPlaying.Listener {
  FrameLayout root;
  ImageView bgArt, art, playBtn, likeBtn;
  View scrim;
  TextView title, artist, posText, durText, upNext, hint;
  SeekBar seek;
  LinearLayout content;
  boolean dragging;
  int shownColor = 0xFF121212;
  ValueAnimator colorAnim;
  final Handler h = new Handler(Looper.getMainLooper());
  float downY;
  long downAt;

  final BroadcastReceiver unlocked = new BroadcastReceiver() {
    @Override public void onReceive(Context c, Intent i) { finishSoft(); }
  };

  static boolean showing;

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    NowPlaying.init(this);
    if (Build.VERSION.SDK_INT >= 27) setShowWhenLocked(true);
    else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
    getWindow().setStatusBarColor(Color.TRANSPARENT);
    getWindow().setNavigationBarColor(Color.TRANSPARENT);
    if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);
    build();
    setContentView(root);
    if (Build.VERSION.SDK_INT >= 33) registerReceiver(unlocked, new IntentFilter(Intent.ACTION_USER_PRESENT), Context.RECEIVER_NOT_EXPORTED);
    else registerReceiver(unlocked, new IntentFilter(Intent.ACTION_USER_PRESENT));
    if (Build.VERSION.SDK_INT >= 33) {
      getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, () -> { /* stay: swipe up to leave */ });
    }
    PlaybackService.cancelLockLaunch(this);
  }

  int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }

  TextView text(float sp, int color, boolean bold) {
    TextView t = new TextView(this);
    t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
    t.setTextColor(color);
    if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    t.setSingleLine(true);
    t.setEllipsize(TextUtils.TruncateAt.END);
    return t;
  }

  ImageView icon(int res, int sizeDp, int padDp, String desc) {
    ImageView v = new ImageView(this);
    v.setImageResource(res);
    v.setPadding(dp(padDp), dp(padDp), dp(padDp), dp(padDp));
    v.setContentDescription(desc);
    v.setImageTintList(ColorStateList.valueOf(Color.WHITE));
    TypedValue tv = new TypedValue();
    getTheme().resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true);
    v.setBackgroundResource(tv.resourceId);
    v.setLayoutParams(new LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp)));
    return v;
  }

  void build() {
    root = new FrameLayout(this);
    root.setBackgroundColor(shownColor);

    bgArt = new ImageView(this);
    bgArt.setScaleType(ImageView.ScaleType.CENTER_CROP);
    bgArt.setAlpha(0.55f);
    if (Build.VERSION.SDK_INT >= 31) bgArt.setRenderEffect(RenderEffect.createBlurEffect(dp(60), dp(60), Shader.TileMode.CLAMP));
    root.addView(bgArt, MainActivity.full());

    scrim = new View(this);
    scrim.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0x66000000, 0x22000000, 0xCC000000}));
    root.addView(scrim, MainActivity.full());

    content = new LinearLayout(this);
    content.setOrientation(LinearLayout.VERTICAL);
    content.setGravity(Gravity.CENTER_HORIZONTAL);
    root.addView(content, MainActivity.full());
    root.setOnApplyWindowInsetsListener((v, ins) -> {
      int l = dp(28), t = dp(24), r = dp(28), b = dp(16);
      if (Build.VERSION.SDK_INT >= 30) {
        Insets i = ins.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
        l += i.left; t += i.top; r += i.right; b += i.bottom;
      } else { t += ins.getSystemWindowInsetTop(); b += ins.getSystemWindowInsetBottom(); }
      content.setPadding(l, t, r, b);
      return ins;
    });

    // Clock.
    TextClock clock = new TextClock(this);
    clock.setFormat12Hour("h:mm");
    clock.setFormat24Hour("H:mm");
    clock.setTextSize(TypedValue.COMPLEX_UNIT_SP, 64);
    clock.setTextColor(Color.WHITE);
    clock.setTypeface(Typeface.create("sans-serif-light", Typeface.NORMAL));
    clock.setGravity(Gravity.CENTER);
    content.addView(clock, wrapCenter());
    TextClock date = new TextClock(this);
    date.setFormat12Hour("EEEE, MMMM d");
    date.setFormat24Hour("EEEE, d MMMM");
    date.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
    date.setTextColor(0xCCFFFFFF);
    content.addView(date, wrapCenter());

    content.addView(new View(this), new LinearLayout.LayoutParams(1, 0, 1f));

    // Art.
    art = new ImageView(this);
    art.setScaleType(ImageView.ScaleType.CENTER_CROP);
    art.setOutlineProvider(new ViewOutlineProvider() {
      @Override public void getOutline(View v, Outline o) { o.setRoundRect(0, 0, v.getWidth(), v.getHeight(), dp(18)); }
    });
    art.setClipToOutline(true);
    art.setElevation(dp(18));
    art.setBackgroundColor(0xFF2A2A2A);
    art.setOnClickListener(v -> openApp());
    LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(0, 0);
    content.addView(art, alp);
    content.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
      int w = r - l - content.getPaddingLeft() - content.getPaddingRight();
      int hgt = b - t;
      int side = Math.min(w, (int) (hgt * 0.42f));
      if (alp.width != side) { alp.width = side; alp.height = side; h.post(art::requestLayout); }
    });

    // Titles + like.
    LinearLayout trow = new LinearLayout(this);
    trow.setOrientation(LinearLayout.HORIZONTAL);
    trow.setGravity(Gravity.CENTER_VERTICAL);
    LinearLayout tcol = new LinearLayout(this);
    tcol.setOrientation(LinearLayout.VERTICAL);
    title = text(24, Color.WHITE, true);
    title.setEllipsize(TextUtils.TruncateAt.MARQUEE);
    title.setMarqueeRepeatLimit(-1);
    title.setSelected(true);
    artist = text(16, 0xB3FFFFFF, false);
    tcol.addView(title);
    tcol.addView(artist);
    trow.addView(tcol, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
    likeBtn = icon(R.drawable.ic_heart, 48, 11, "Like");
    likeBtn.setOnClickListener(v -> act("like"));
    trow.addView(likeBtn);
    LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    tlp.topMargin = dp(28);
    content.addView(trow, tlp);

    // Seek bar.
    seek = new SeekBar(this);
    seek.setMax(1000);
    seek.setPadding(0, dp(8), 0, dp(8));
    seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
      @Override public void onProgressChanged(SeekBar s, int p, boolean user) { if (user) posText.setText(NowPlaying.time(p / 1000.0 * NowPlaying.dur)); }
      @Override public void onStartTrackingTouch(SeekBar s) { dragging = true; }
      @Override public void onStopTrackingTouch(SeekBar s) {
        dragging = false;
        double to = s.getProgress() / 1000.0 * NowPlaying.dur;
        MainActivity m = MainActivity.live;
        if (m != null && NowPlaying.dur > 0) { m.mediaAction("seek", to); NowPlaying.pos = to; NowPlaying.posAt = android.os.SystemClock.elapsedRealtime(); }
      }
    });
    LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    slp.topMargin = dp(14);
    slp.leftMargin = -dp(14); slp.rightMargin = -dp(14);
    content.addView(seek, slp);
    LinearLayout times = new LinearLayout(this);
    posText = text(12, 0xB3FFFFFF, false);
    durText = text(12, 0xB3FFFFFF, false);
    durText.setGravity(Gravity.END);
    times.addView(posText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
    times.addView(durText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
    content.addView(times, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

    // Controls.
    LinearLayout ctl = new LinearLayout(this);
    ctl.setGravity(Gravity.CENTER);
    ImageView prev = icon(R.drawable.ic_prev, 64, 14, "Previous");
    prev.setOnClickListener(v -> act("prev"));
    ImageView next = icon(R.drawable.ic_next, 64, 14, "Next");
    next.setOnClickListener(v -> act("next"));
    playBtn = new ImageView(this);
    playBtn.setPadding(dp(22), dp(22), dp(22), dp(22));
    GradientDrawable circle = new GradientDrawable();
    circle.setShape(GradientDrawable.OVAL);
    circle.setColor(Color.WHITE);
    playBtn.setBackground(circle);
    playBtn.setElevation(dp(6));
    playBtn.setContentDescription("Play");
    playBtn.setOnClickListener(v -> act("toggle"));
    LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(dp(80), dp(80));
    plp.leftMargin = dp(28); plp.rightMargin = dp(28);
    ctl.addView(prev);
    ctl.addView(playBtn, plp);
    ctl.addView(next);
    LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    clp.topMargin = dp(10);
    content.addView(ctl, clp);

    upNext = text(13, 0x99FFFFFF, false);
    upNext.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams ulp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    ulp.topMargin = dp(14);
    content.addView(upNext, ulp);

    content.addView(new View(this), new LinearLayout.LayoutParams(1, 0, 1f));

    hint = text(13, 0x99FFFFFF, false);
    hint.setText("Swipe up to unlock");
    hint.setGravity(Gravity.CENTER);
    hint.setCompoundDrawablesRelativeWithIntrinsicBounds(0, R.drawable.ic_up, 0, 0);
    hint.setCompoundDrawableTintList(ColorStateList.valueOf(0x99FFFFFF));
    content.addView(hint, wrapCenter());
  }

  LinearLayout.LayoutParams wrapCenter() {
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    lp.gravity = Gravity.CENTER_HORIZONTAL;
    return lp;
  }

  void act(String a) {
    MainActivity m = MainActivity.live;
    if (m == null) { openApp(); return; }
    if (a.equals("toggle")) { NowPlaying.playing = !NowPlaying.playing; NowPlaying.posAt = android.os.SystemClock.elapsedRealtime(); render(false); }
    if (a.equals("like")) { NowPlaying.liked = !NowPlaying.liked; render(false); }
    m.mediaAction(a, 0);
  }

  void openApp() {
    Intent i = new Intent(this, MainActivity.class).putExtra("openPlayer", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    dismissKeyguard(() -> { startActivity(i); finishSoft(); });
  }

  void dismissKeyguard(Runnable then) {
    KeyguardManager km = getSystemService(KeyguardManager.class);
    if (km != null && km.isKeyguardLocked() && Build.VERSION.SDK_INT >= 26) {
      km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
        @Override public void onDismissSucceeded() { then.run(); }
      });
    } else then.run();
  }

  void finishSoft() {
    if (isFinishing()) return;
    finish();
    overridePendingTransition(0, android.R.anim.fade_out);
  }

  // Swipe up anywhere outside the controls to leave.
  @Override
  public boolean dispatchTouchEvent(MotionEvent e) {
    switch (e.getActionMasked()) {
      case MotionEvent.ACTION_DOWN: downY = e.getRawY(); downAt = e.getEventTime(); break;
      case MotionEvent.ACTION_MOVE: {
        float dy = downY - e.getRawY();
        if (dy > 0 && !dragging) { content.setTranslationY(-dy * 0.35f); content.setAlpha(Math.max(0.2f, 1 - dy / (root.getHeight() * 0.6f))); }
        break;
      }
      case MotionEvent.ACTION_UP:
      case MotionEvent.ACTION_CANCEL: {
        float dy = downY - e.getRawY();
        long dt = e.getEventTime() - downAt;
        if (!dragging && (dy > root.getHeight() * 0.22f || (dy > dp(60) && dt < 250))) {
          content.animate().translationY(-root.getHeight() * 0.3f).alpha(0).setDuration(180).start();
          dismissKeyguard(this::finishSoft);
          h.postDelayed(() -> { if (!isFinishing()) { content.animate().translationY(0).alpha(1).setDuration(200).start(); } }, 1500);
          return true;
        }
        content.animate().translationY(0).alpha(1).setDuration(200).setInterpolator(new DecelerateInterpolator()).start();
        break;
      }
      default:
    }
    return super.dispatchTouchEvent(e);
  }

  @Override
  public void onNowPlaying(boolean songChanged) { render(songChanged); }

  void render(boolean songChanged) {
    title.setText(NowPlaying.title.isEmpty() ? "Wavelength" : NowPlaying.title);
    artist.setText(NowPlaying.artist);
    if (NowPlaying.art != null) {
      if (art.getDrawable() == null || songChanged) {
        art.setImageBitmap(NowPlaying.art);
        bgArt.setImageBitmap(NowPlaying.art);
        if (songChanged) { art.setAlpha(0f); art.animate().alpha(1f).setDuration(350).start(); }
      }
    }
    playBtn.setImageResource(NowPlaying.playing ? R.drawable.ic_pause : R.drawable.ic_play);
    playBtn.setImageTintList(ColorStateList.valueOf(NowWidget.darkFor(NowPlaying.color)));
    playBtn.setContentDescription(NowPlaying.playing ? "Pause" : "Play");
    likeBtn.setImageResource(NowPlaying.liked ? R.drawable.ic_heart_on : R.drawable.ic_heart);
    float sc = NowPlaying.playing ? 1f : 0.9f;
    art.animate().scaleX(sc).scaleY(sc).setDuration(320).setInterpolator(new DecelerateInterpolator()).start();
    int accent = NowPlaying.art != null ? NowPlaying.accent : Color.WHITE;
    seek.setProgressTintList(ColorStateList.valueOf(accent));
    seek.setThumbTintList(ColorStateList.valueOf(accent));
    seek.setProgressBackgroundTintList(ColorStateList.valueOf(0x40FFFFFF));
    if (!NowPlaying.upNext.isEmpty()) {
      NowPlaying.Item n = NowPlaying.upNext.get(0);
      upNext.setText("Up next  ·  " + n.title + (n.artist.isEmpty() ? "" : " — " + n.artist));
      upNext.setVisibility(View.VISIBLE);
    } else if (!NowPlaying.roomLine.isEmpty()) { upNext.setText(NowPlaying.roomLine); upNext.setVisibility(View.VISIBLE); }
    else upNext.setVisibility(View.INVISIBLE);
    fadeColor(NowPlaying.art != null ? NowPlaying.color : 0xFF121212);
    tick();
  }

  void fadeColor(int to) {
    if (to == shownColor) return;
    if (colorAnim != null) colorAnim.cancel();
    colorAnim = ValueAnimator.ofObject(new ArgbEvaluator(), shownColor, to);
    colorAnim.setDuration(600);
    colorAnim.addUpdateListener(a -> { shownColor = (int) a.getAnimatedValue(); root.setBackgroundColor(shownColor); });
    colorAnim.start();
  }

  final Runnable ticker = new Runnable() {
    @Override public void run() { tick(); h.postDelayed(this, 500); }
  };

  void tick() {
    double d = NowPlaying.dur, p = NowPlaying.position();
    if (!dragging) {
      seek.setProgress(d > 0 ? (int) (p / d * 1000) : 0);
      posText.setText(NowPlaying.time(p));
    }
    durText.setText(d > 0 ? "-" + NowPlaying.time(Math.max(0, d - p)) : "");
  }

  @Override
  protected void onStart() {
    super.onStart();
    showing = true;
    NowPlaying.addListener(this);
    render(true);
    h.post(ticker);
  }

  @Override
  protected void onResume() {
    super.onResume();
    // The screen came on but the phone isn't locked (no lock screen, or it
    // hadn't locked yet): there's nothing to cover, get out of the way.
    KeyguardManager km = getSystemService(KeyguardManager.class);
    android.os.PowerManager pm = getSystemService(android.os.PowerManager.class);
    if (getIntent().getBooleanExtra("demo", false)) return;
    h.postDelayed(() -> {
      if (km != null && pm != null && pm.isInteractive() && !km.isKeyguardLocked() && !isFinishing()) finishSoft();
    }, 700);
  }

  @Override
  protected void onStop() {
    super.onStop();
    showing = false;
    NowPlaying.removeListener(this);
    h.removeCallbacks(ticker);
  }

  @Override
  protected void onDestroy() {
    try { unregisterReceiver(unlocked); } catch (Exception e) { /* not registered */ }
    super.onDestroy();
  }

  @Override
  public void onBackPressed() { /* swipe up to leave */ }
}
