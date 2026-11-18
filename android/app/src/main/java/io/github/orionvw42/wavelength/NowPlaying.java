package io.github.orionvw42.wavelength;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.LruCache;

import androidx.palette.graphics.Palette;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * What's playing, shared by everything outside the web views: the media
 * session + notification, the lock screen player and the home screen widget.
 * Album art is downloaded once at full size, cropped square (video thumbnails
 * have black bars) and its colors picked out for the backgrounds.
 */
final class NowPlaying {
  interface Listener { void onNowPlaying(boolean songChanged); }

  static final class Item {
    String uid, videoId, title, artist, art, by;
    Item(JSONObject o) {
      uid = o.optString("uid"); videoId = o.optString("videoId"); title = o.optString("title");
      artist = o.optString("artist"); art = o.optString("art"); by = o.isNull("by") ? "" : o.optString("by");
    }
  }

  static String videoId = "", title = "", artist = "", artUrl = "";
  static boolean playing, liked, ad, hasSong;
  static double pos, dur;
  static long posAt;                  // elapsedRealtime when pos was read
  static long lastPlayingAt;          // elapsedRealtime music was last heard
  static Bitmap art;                  // square, ≤ 720px
  static int color = 0xFF202020;      // dark background tint picked from the art
  static int accent = 0xFFFFFFFF;     // bright accent picked from the art
  static List<Item> upNext = new ArrayList<>();
  static String roomLine = "";

  static final List<Listener> listeners = new CopyOnWriteArrayList<>();
  static final Handler main = new Handler(Looper.getMainLooper());
  static final ExecutorService net = Executors.newFixedThreadPool(3);
  static final LruCache<String, Bitmap> thumbs = new LruCache<String, Bitmap>(4 * 1024 * 1024) {
    @Override protected int sizeOf(String k, Bitmap b) { return b.getByteCount(); }
  };
  static Context app;

  static void init(Context c) {
    if (app != null) return;
    app = c.getApplicationContext();
    SharedPreferences p = prefs();
    videoId = p.getString("videoId", ""); title = p.getString("title", ""); artist = p.getString("artist", "");
    hasSong = !videoId.isEmpty();
    String url = p.getString("art", "");
    if (!url.isEmpty()) loadArt(url);
  }
  static SharedPreferences prefs() { return app.getSharedPreferences("now", Context.MODE_PRIVATE); }

  /** Current position, moving with the clock while playing. */
  static double position() {
    double p = pos + (playing ? (SystemClock.elapsedRealtime() - posAt) / 1000.0 : 0);
    return dur > 0 ? Math.min(p, dur) : p;
  }

  static void addListener(Listener l) { if (!listeners.contains(l)) listeners.add(l); }
  static void removeListener(Listener l) { listeners.remove(l); }
  static void notifyAll(boolean songChanged) {
    main.post(() -> { for (Listener l : listeners) { try { l.onNowPlaying(songChanged); } catch (Exception e) { /* keep going */ } } });
  }

  /** From the engine's state message. Returns true if something visible changed. */
  static void onState(JSONObject s) {
    boolean wasPlaying = playing, wasLiked = liked;
    String prevId = videoId;
    String prevTitle = title;
    double expected = position();
    ad = s.optBoolean("ad");
    if (ad) return; // keep showing the song while an ad is (muted and) skipped
    String id = s.optString("videoId", "");
    if (id.isEmpty() || "null".equals(id)) return;
    videoId = id;
    playing = s.optBoolean("playing");
    if (playing || wasPlaying) lastPlayingAt = SystemClock.elapsedRealtime();
    pos = s.optDouble("position", 0);
    dur = s.optDouble("duration", 0);
    posAt = SystemClock.elapsedRealtime();
    title = s.optString("title", "");
    artist = s.optString("artist", "");
    liked = s.optBoolean("liked");
    hasSong = true;
    String a = s.optString("art", "");
    boolean songChanged = !videoId.equals(prevId);
    if (!a.isEmpty() && !"null".equals(a) && !hiRes(a).equals(artUrl)) loadArt(a);
    else if (songChanged && (a.isEmpty() || "null".equals(a))) loadArt("https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg");
    boolean jumped = Math.abs(expected - pos) > 2.5;
    if (songChanged || !title.equals(prevTitle)) {
      prefs().edit().putString("videoId", videoId).putString("title", title).putString("artist", artist).apply();
    }
    if (songChanged || wasPlaying != playing || wasLiked != liked || jumped || !title.equals(prevTitle)) notifyAll(songChanged);
  }

  /** From the UI's session: Up Next and the room line. */
  static void onQueue(JSONObject o) {
    List<Item> list = new ArrayList<>();
    JSONArray a = o.optJSONArray("upNext");
    if (a != null) for (int i = 0; i < a.length() && i < 25; i++) { JSONObject t = a.optJSONObject(i); if (t != null) list.add(new Item(t)); }
    String room = o.optString("room", "");
    boolean same = list.size() == upNext.size() && room.equals(roomLine);
    if (same) for (int i = 0; i < list.size(); i++) if (!list.get(i).uid.equals(upNext.get(i).uid)) { same = false; break; }
    upNext = list;
    roomLine = room;
    if (!same) notifyAll(false);
  }

  // ------------------------------------------------------------ art
  /** Ask YouTube's image servers for a big square version. */
  static String hiRes(String url) {
    if (url == null) return "";
    if (url.contains("googleusercontent.com") || url.contains("ggpht.com")) {
      return url.replaceAll("=w\\d+-h\\d+[^&?#]*$", "=w720-h720-l90-rj").replaceAll("=s\\d+[^&?#]*$", "=s720");
    }
    if (url.contains("i.ytimg.com/vi/")) return url.replaceAll("/(default|mqdefault|sddefault|maxresdefault|hq720)\\.jpg.*$", "/hqdefault.jpg");
    return url;
  }

  static void loadArt(String raw) {
    String url = hiRes(raw);
    artUrl = url;
    prefs().edit().putString("art", raw).apply();
    net.execute(() -> {
      Bitmap b = fetch(url, 720);
      if (b == null && !url.equals(raw)) b = fetch(raw, 720);
      if (b == null) return;
      Bitmap sq = squareCrop(b);
      int[] cols = colors(sq);
      main.post(() -> {
        if (!url.equals(artUrl)) return;
        art = sq; color = cols[0]; accent = cols[1];
        notifyAll(true);
      });
    });
  }

  /** Small square thumbnail for list rows (cached). */
  static void thumb(String raw, int px, java.util.function.Consumer<Bitmap> done) {
    if (raw == null || raw.isEmpty()) { done.accept(null); return; }
    String key = raw + "@" + px;
    Bitmap c = thumbs.get(key);
    if (c != null) { done.accept(c); return; }
    net.execute(() -> {
      Bitmap b = fetch(raw, px * 2);
      Bitmap sq = b == null ? null : Bitmap.createScaledBitmap(squareCrop(b), px, px, true);
      if (sq != null) thumbs.put(key, sq);
      main.post(() -> done.accept(sq));
    });
  }

  static Bitmap fetch(String url, int maxPx) {
    try {
      HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
      c.setConnectTimeout(8000); c.setReadTimeout(10000);
      if (c.getResponseCode() != 200) return null;
      byte[] data;
      try (InputStream in = c.getInputStream()) {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        for (int r; (r = in.read(buf)) > 0; ) out.write(buf, 0, r);
        data = out.toByteArray();
      }
      BitmapFactory.Options o = new BitmapFactory.Options();
      o.inJustDecodeBounds = true;
      BitmapFactory.decodeByteArray(data, 0, data.length, o);
      int sample = 1;
      while (Math.min(o.outWidth, o.outHeight) / (sample * 2) >= maxPx) sample *= 2;
      o = new BitmapFactory.Options();
      o.inSampleSize = sample;
      return BitmapFactory.decodeByteArray(data, 0, data.length, o);
    } catch (Exception e) { return null; }
  }

  /** Square crop of the picture itself: letterbox bars (YouTube video
   *  thumbnails are 4:3 with a 16:9 picture inside) are trimmed first. */
  static Bitmap squareCrop(Bitmap b) {
    int w = b.getWidth(), h = b.getHeight();
    if (Math.abs(w - h) <= 2) return w > 720 ? Bitmap.createScaledBitmap(b, 720, 720, true) : b;
    int top = 0, bottom = h;
    while (top < h / 3 && darkRow(b, top)) top++;
    while (bottom > h * 2 / 3 && darkRow(b, bottom - 1)) bottom--;
    int ch = bottom - top;
    int side = Math.min(w, ch);
    int x = (w - side) / 2, y = top + (ch - side) / 2;
    Bitmap out = Bitmap.createBitmap(b, x, y, side, side);
    if (side > 720) out = Bitmap.createScaledBitmap(out, 720, 720, true);
    return out;
  }
  private static boolean darkRow(Bitmap b, int y) {
    int w = b.getWidth();
    for (int i = 0; i < 12; i++) {
      int c = b.getPixel(w * (2 * i + 1) / 24, y);
      if (Color.red(c) + Color.green(c) + Color.blue(c) > 60) return false;
    }
    return true;
  }

  /** {dark background, bright accent} from the art. */
  static int[] colors(Bitmap b) {
    try {
      Palette p = Palette.from(b).maximumColorCount(16).generate();
      Palette.Swatch bg = first(p.getDarkMutedSwatch(), p.getDarkVibrantSwatch(), p.getMutedSwatch(), p.getDominantSwatch());
      Palette.Swatch ac = first(p.getVibrantSwatch(), p.getLightVibrantSwatch(), p.getLightMutedSwatch(), p.getDominantSwatch());
      int dark = bg == null ? 0xFF202020 : darken(bg.getRgb(), 0.42f);
      int acc = ac == null ? 0xFFFFFFFF : lighten(ac.getRgb(), 0.55f);
      return new int[]{dark, acc};
    } catch (Exception e) { return new int[]{0xFF202020, 0xFFFFFFFF}; }
  }
  private static Palette.Swatch first(Palette.Swatch... s) { for (Palette.Swatch x : s) if (x != null) return x; return null; }
  static int darken(int c, float maxLight) {
    float[] hsl = new float[3];
    androidx.core.graphics.ColorUtils.colorToHSL(c, hsl);
    hsl[2] = Math.min(hsl[2], maxLight * 0.5f);
    hsl[1] = Math.min(hsl[1], 0.6f);
    return androidx.core.graphics.ColorUtils.HSLToColor(hsl);
  }
  static int lighten(int c, float minLight) {
    float[] hsl = new float[3];
    androidx.core.graphics.ColorUtils.colorToHSL(c, hsl);
    hsl[2] = Math.max(hsl[2], minLight);
    return androidx.core.graphics.ColorUtils.HSLToColor(hsl);
  }

  static String time(double s) {
    if (!(s >= 0) || Double.isInfinite(s)) s = 0;
    int t = (int) s;
    return t >= 3600 ? String.format("%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60) : String.format("%d:%02d", t / 60, t % 60);
  }

  private NowPlaying() {}
}
