package io.github.orionvw42.wavelength;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.SizeF;
import android.view.View;
import android.widget.RemoteViews;

import java.util.HashMap;
import java.util.Map;

/**
 * The home screen widget. It can be resized freely: Android picks the
 * layout that fits (a button bar, a square, a strip, a card, a column, a
 * full player, or a full player with Up next).
 */
public class NowWidget extends AppWidgetProvider {
  static final String ACT = "io.github.orionvw42.wavelength.WIDGET";
  static final Handler main = new Handler(Looper.getMainLooper());
  static boolean pending, ticking;
  static Bitmap placeholder, lastArtSrc, art565, blurred;
  static final NowPlaying.Listener listener = (songChanged) -> update(NowPlaying.app);

  // Layouts, smallest first: {layout, min width dp, min height dp}.
  static final int[][] SIZES = {
      {R.layout.widget_tiny, 100, 40},
      {R.layout.widget_square, 100, 100},
      {R.layout.widget_strip, 200, 40},
      {R.layout.widget_column, 150, 190},
      {R.layout.widget_card, 250, 130},
      {R.layout.widget_big, 260, 200},
      {R.layout.widget_huge, 260, 360},
  };

  @Override
  public void onUpdate(Context c, AppWidgetManager m, int[] ids) { NowPlaying.init(c); hook(); updateNow(c); }

  @Override
  public void onAppWidgetOptionsChanged(Context c, AppWidgetManager m, int id, Bundle opts) { NowPlaying.init(c); updateNow(c); }

  @Override
  public void onEnabled(Context c) { NowPlaying.init(c); hook(); }

  @Override
  public void onReceive(Context c, Intent i) {
    super.onReceive(c, i);
    if (!ACT.equals(i.getAction())) return;
    NowPlaying.init(c);
    String a = i.getStringExtra("a");
    String uid = i.getStringExtra("uid");
    MainActivity m = MainActivity.live;
    if (m != null) {
      if (uid != null) m.uiAction(MainActivity.obj("t", "action", "name", "playNow", "uid", uid));
      else m.mediaAction(a, 0);
    } else {
      // The app isn't running: open it (it starts playing where it left off).
      try {
        c.startActivity(new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("autoplay", "toggle".equals(a) || "next".equals(a)));
      } catch (Exception e) { /* blocked: the widget below now opens the app directly */ }
      update(c);
    }
  }

  static void hook() { NowPlaying.addListener(listener); }

  static int[] ids(Context c) {
    return AppWidgetManager.getInstance(c).getAppWidgetIds(new ComponentName(c, NowWidget.class));
  }

  /** Coalesces bursts of changes into one redraw. */
  static void update(Context c) {
    if (c == null || pending) return;
    pending = true;
    main.postDelayed(() -> { pending = false; updateNow(c); }, 150);
  }

  static void updateNow(Context c) {
    int[] ids = ids(c);
    if (ids.length == 0) return;
    hook();
    AppWidgetManager mgr = AppWidgetManager.getInstance(c);
    prepareArt(c);
    for (int id : ids) {
      try { mgr.updateAppWidget(id, build(c)); }
      catch (Exception e) { android.util.Log.w(MainActivity.TAG, "widget: " + e); }
    }
    scheduleTick(c);
  }

  /** While playing, the progress bar moves every 15 seconds. */
  static void scheduleTick(Context c) {
    if (ticking || !NowPlaying.playing) return;
    ticking = true;
    main.postDelayed(() -> { ticking = false; if (NowPlaying.playing && ids(c).length > 0) updateNow(c); }, 15000);
  }

  static RemoteViews build(Context c) {
    if (Build.VERSION.SDK_INT >= 31) {
      Map<SizeF, RemoteViews> map = new HashMap<>();
      for (int[] s : SIZES) map.put(new SizeF(s[1], s[2]), fill(c, s[0]));
      return new RemoteViews(map);
    }
    return fill(c, R.layout.widget_card);
  }

  static void prepareArt(Context c) {
    Bitmap src = NowPlaying.art;
    if (src == null) {
      if (placeholder == null) placeholder = makePlaceholder(c);
      art565 = placeholder; blurred = null; lastArtSrc = null;
      return;
    }
    if (src == lastArtSrc) return;
    lastArtSrc = src;
    // One 360px copy (no alpha: half the memory) shared by every layout.
    Bitmap s = Bitmap.createScaledBitmap(src, 360, 360, true);
    art565 = s.copy(Bitmap.Config.RGB_565, false);
    // A tiny copy, stretched over the background, reads as a soft blur.
    blurred = Bitmap.createScaledBitmap(Bitmap.createScaledBitmap(src, 12, 12, true), 36, 36, true).copy(Bitmap.Config.RGB_565, false);
  }

  static Bitmap makePlaceholder(Context c) {
    Bitmap b = Bitmap.createBitmap(200, 200, Bitmap.Config.RGB_565);
    Canvas cv = new Canvas(b);
    cv.drawColor(0xFF2A2A2A);
    Drawable d = c.getDrawable(R.drawable.ic_note);
    if (d != null) { d.setTint(0x66FFFFFF); d.setBounds(60, 60, 140, 140); d.draw(cv); }
    return b;
  }

  static RemoteViews fill(Context c, int layout) {
    RemoteViews v = new RemoteViews(c.getPackageName(), layout);
    boolean has = NowPlaying.hasSong;
    boolean live = MainActivity.live != null;
    int bg = NowPlaying.art != null ? NowPlaying.color : 0xFF1C1C1C;

    v.setInt(R.id.bg_color, "setColorFilter", bg);
    if (blurred != null) { v.setImageViewBitmap(R.id.bg_art, blurred); v.setInt(R.id.bg_art, "setImageAlpha", 70); }
    else v.setImageViewBitmap(R.id.bg_art, null);
    v.setImageViewBitmap(R.id.art, art565);

    v.setTextViewText(R.id.title, has && !NowPlaying.title.isEmpty() ? NowPlaying.title : "Wavelength");
    String sub = has ? NowPlaying.artist : "Tap to start listening";
    if (layout != R.layout.widget_tiny) v.setTextViewText(R.id.artist, sub);
    if (layout == R.layout.widget_card || layout == R.layout.widget_big || layout == R.layout.widget_huge) {
      String lbl = !NowPlaying.roomLine.isEmpty() ? NowPlaying.roomLine : (NowPlaying.playing ? "Now playing" : (has ? "Paused" : "Wavelength"));
      v.setTextViewText(R.id.label, lbl);
    }

    // Progress.
    double d = NowPlaying.dur, p = NowPlaying.position();
    if (layout != R.layout.widget_tiny && layout != R.layout.widget_square && layout != R.layout.widget_strip) {
      v.setProgressBar(R.id.progress, 1000, d > 0 ? (int) (p / d * 1000) : 0, false);
      if (Build.VERSION.SDK_INT >= 31) {
        v.setColorStateList(R.id.progress, "setProgressTintList", ColorStateList.valueOf(NowPlaying.art != null ? NowPlaying.accent : Color.WHITE));
      }
    }
    if (layout == R.layout.widget_big || layout == R.layout.widget_huge) {
      v.setTextViewText(R.id.pos, NowPlaying.time(p));
      v.setTextViewText(R.id.dur, NowPlaying.time(d));
    }

    // Buttons.
    v.setImageViewResource(R.id.play, NowPlaying.playing ? R.drawable.ic_pause : R.drawable.ic_play);
    v.setInt(R.id.play, "setColorFilter", darkFor(bg));
    v.setContentDescription(R.id.play, NowPlaying.playing ? "Pause" : "Play");
    v.setOnClickPendingIntent(R.id.play, act(c, "toggle", 1, live));
    v.setOnClickPendingIntent(R.id.next, act(c, "next", 2, live));
    if (layout != R.layout.widget_tiny && layout != R.layout.widget_square) v.setOnClickPendingIntent(R.id.prev, act(c, "prev", 3, live));
    if (layout == R.layout.widget_card || layout == R.layout.widget_big || layout == R.layout.widget_huge) {
      v.setImageViewResource(R.id.like, NowPlaying.liked ? R.drawable.ic_heart_on : R.drawable.ic_heart);
      v.setOnClickPendingIntent(R.id.like, act(c, "like", 4, live));
    }
    if (layout == R.layout.widget_card || layout == R.layout.widget_big || layout == R.layout.widget_huge) v.setOnClickPendingIntent(R.id.radio, act(c, "radio", 5, live));
    PendingIntent open = PendingIntent.getActivity(c, 10, new Intent(c, MainActivity.class).putExtra("openPlayer", true)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    v.setOnClickPendingIntent(R.id.art, open);
    v.setOnClickPendingIntent(R.id.title, open);
    v.setOnClickPendingIntent(android.R.id.background, open);

    if (layout == R.layout.widget_huge) fillList(c, v);
    return v;
  }

  static void fillList(Context c, RemoteViews v) {
    boolean empty = NowPlaying.upNext.isEmpty();
    v.setViewVisibility(R.id.empty, empty ? View.VISIBLE : View.GONE);
    v.setViewVisibility(R.id.list, empty ? View.GONE : View.VISIBLE);
    int n0 = NowPlaying.upNext.size();
    v.setTextViewText(R.id.upnext_label, empty ? "Up next" : "Up next · " + n0 + (n0 >= 25 ? "+ songs" : n0 == 1 ? " song" : " songs"));
    if (Build.VERSION.SDK_INT < 31 || empty) return;
    RemoteViews.RemoteCollectionItems.Builder b = new RemoteViews.RemoteCollectionItems.Builder().setHasStableIds(false).setViewTypeCount(1);
    boolean missing = false;
    int n = 0;
    for (NowPlaying.Item it : NowPlaying.upNext) {
      if (n++ >= 12) break;
      RemoteViews r = new RemoteViews(c.getPackageName(), R.layout.widget_row);
      r.setTextViewText(R.id.row_title, it.title);
      r.setTextViewText(R.id.row_sub, it.by.isEmpty() || NowPlaying.roomLine.isEmpty() ? it.artist : it.artist + " · added by " + it.by);
      Bitmap t = it.art.isEmpty() ? null : NowPlaying.thumbs.get(it.art + "@64");
      if (t != null) r.setImageViewBitmap(R.id.row_art, t);
      else if (!it.art.isEmpty()) { missing = true; NowPlaying.thumb(it.art, 64, (bmp) -> { if (bmp != null) update(c); }); }
      Intent fill = new Intent().putExtra("uid", it.uid);
      r.setOnClickFillInIntent(R.id.row, fill);
      b.addItem(n, r);
    }
    v.setRemoteAdapter(R.id.list, b.build());
    Intent tpl = new Intent(c, NowWidget.class).setAction(ACT);
    v.setPendingIntentTemplate(R.id.list, PendingIntent.getBroadcast(c, 20, tpl, PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
  }

  static PendingIntent act(Context c, String a, int code, boolean live) {
    if (!live) {
      Intent i = new Intent(c, MainActivity.class).putExtra("autoplay", "toggle".equals(a) || "next".equals(a)).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
      return PendingIntent.getActivity(c, 100 + code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
    Intent i = new Intent(c, NowWidget.class).setAction(ACT).putExtra("a", a);
    return PendingIntent.getBroadcast(c, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
  }

  /** The play icon sits on a white circle: draw it in the widget's own color. */
  static int darkFor(int bg) {
    float[] hsl = new float[3];
    androidx.core.graphics.ColorUtils.colorToHSL(bg, hsl);
    hsl[2] = Math.min(hsl[2], 0.18f);
    return androidx.core.graphics.ColorUtils.HSLToColor(hsl);
  }

}
