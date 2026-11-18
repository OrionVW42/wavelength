package io.github.orionvw42.wavelength;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * Keeps Wavelength alive while it plays in the background or with the screen
 * off: a "now playing" notification (a foreground service, which Android
 * doesn't freeze), the media session for the lock screen / headphones /
 * Bluetooth / car, pausing when headphones unplug, wake locks, and the big lock screen player.
 */
public class PlaybackService extends Service implements NowPlaying.Listener {
  static PlaybackService inst;
  static final String CHANNEL = "playback", LOCK_CHANNEL = "lockplayer";
  static final int ID = 1, LOCK_ID = 2;

  MediaSessionCompat session;
  PowerManager.WakeLock cpu;
  WifiManager.WifiLock wifi;
  final Handler ui = new Handler(Looper.getMainLooper());

  final BroadcastReceiver receiver = new BroadcastReceiver() {
    @Override public void onReceive(Context c, Intent i) {
      String a = i.getAction();
      if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(a)) {
        // Headphones unplugged / Bluetooth dropped: don't blast the speaker.
        if (NowPlaying.playing) cmd("pause", 0);
      } else if (Intent.ACTION_SCREEN_ON.equals(a)) {
        // Shown as the screen comes on (doing it at screen-off would make
        // Android switch the screen right back on).
        maybeShowLockPlayer();
      }
    }
  };

  @Override
  public void onCreate() {
    super.onCreate();
    inst = this;
    NowPlaying.init(this);
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel ch = new NotificationChannel(CHANNEL, "Now playing", NotificationManager.IMPORTANCE_LOW);
      ch.setShowBadge(false);
      nm.createNotificationChannel(ch);
      NotificationChannel lock = new NotificationChannel(LOCK_CHANNEL, "Lock screen player", NotificationManager.IMPORTANCE_HIGH);
      lock.setSound(null, null);
      lock.enableVibration(false);
      lock.setShowBadge(false);
      lock.setDescription("Opens the big player on the lock screen when the screen turns off while music plays.");
      nm.createNotificationChannel(lock);
    }
    session = new MediaSessionCompat(this, "Wavelength");
    session.setCallback(new MediaSessionCompat.Callback() {
      @Override public void onPlay() { cmd("play", 0); }
      @Override public void onPause() { cmd("pause", 0); }
      @Override public void onSkipToNext() { cmd("next", 0); }
      @Override public void onSkipToPrevious() { cmd("prev", 0); }
      @Override public void onSeekTo(long ms) { cmd("seek", ms / 1000.0); NowPlaying.pos = ms / 1000.0; NowPlaying.posAt = SystemClock.elapsedRealtime(); apply(); }
      @Override public void onStop() { cmd("pause", 0); }
      @Override public void onCustomAction(String action, Bundle extras) {
        if ("wl.like".equals(action)) { NowPlaying.liked = !NowPlaying.liked; cmd("like", 0); apply(); }
        else if ("wl.radio".equals(action)) cmd("radio", 0);
      }
    });
    session.setSessionActivity(openIntent());
    session.setActive(true);
    cpu = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Wavelength:playback");
    cpu.setReferenceCounted(false);
    wifi = ((WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE)).createWifiLock(
        Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Wavelength:stream");
    wifi.setReferenceCounted(false);
    IntentFilter f = new IntentFilter();
    f.addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
    f.addAction(Intent.ACTION_SCREEN_ON);
    if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED);
    else registerReceiver(receiver, f);
    NowPlaying.addListener(this);
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    Notification n = build();
    try {
      if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
      else startForeground(ID, n);
    } catch (Exception e) { Log.w(MainActivity.TAG, "startForeground: " + e); }
    String a = intent == null ? null : intent.getAction();
    if (a != null) {
      switch (a) {
        case "wl.toggle": cmd("toggle", 0); break;
        case "wl.next": cmd("next", 0); break;
        case "wl.prev": cmd("prev", 0); break;
        case "wl.like": NowPlaying.liked = !NowPlaying.liked; cmd("like", 0); break;
        default:
      }
    }
    apply();
    return START_NOT_STICKY;
  }

  static void cmd(String a, double x) {
    MainActivity m = MainActivity.live;
    if (m != null) m.mediaAction(a, x);
  }

  /** Called whenever the song or play state changes. */
  static void update() {
    if (inst != null) inst.ui.post(inst::apply);
  }

  @Override
  public void onNowPlaying(boolean songChanged) { apply(); }

  void apply() {
    MediaMetadataCompat.Builder md = new MediaMetadataCompat.Builder()
        .putString(MediaMetadataCompat.METADATA_KEY_MEDIA_ID, NowPlaying.videoId)
        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, NowPlaying.title.isEmpty() ? "Wavelength" : NowPlaying.title)
        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, NowPlaying.artist)
        .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, NowPlaying.title.isEmpty() ? "Wavelength" : NowPlaying.title)
        .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, NowPlaying.artist)
        .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (long) (NowPlaying.dur * 1000));
    if (NowPlaying.art != null) md.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, NowPlaying.art).putBitmap(MediaMetadataCompat.METADATA_KEY_ART, NowPlaying.art);
    session.setMetadata(md.build());
    session.setPlaybackState(new PlaybackStateCompat.Builder()
        .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
            | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS | PlaybackStateCompat.ACTION_SEEK_TO
            | PlaybackStateCompat.ACTION_STOP)
        .addCustomAction(new PlaybackStateCompat.CustomAction.Builder("wl.like", NowPlaying.liked ? "Unlike" : "Like",
            NowPlaying.liked ? R.drawable.ic_heart_on : R.drawable.ic_heart).build())
        .addCustomAction(new PlaybackStateCompat.CustomAction.Builder("wl.radio", "Start radio", R.drawable.ic_radio).build())
        .setState(NowPlaying.playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
            (long) (NowPlaying.pos * 1000), NowPlaying.playing ? 1f : 0f, NowPlaying.posAt == 0 ? SystemClock.elapsedRealtime() : NowPlaying.posAt)
        .build());
    if (NowPlaying.playing) {
      cpu.acquire(4 * 60 * 60 * 1000L);
      wifi.acquire();
    } else {
      if (cpu.isHeld()) cpu.release();
      if (wifi.isHeld()) wifi.release();
    }
    try { getSystemService(NotificationManager.class).notify(ID, build()); } catch (Exception e) { Log.w(MainActivity.TAG, "notify: " + e); }
  }

  // ------------------------------------------------------------ lock screen player
  static boolean lockPlayerOn(Context c) {
    return c.getSharedPreferences("app", MODE_PRIVATE).getBoolean("lockPlayer", true);
  }

  void maybeShowLockPlayer() {
    boolean recent = NowPlaying.playing || SystemClock.elapsedRealtime() - NowPlaying.lastPlayingAt < 15 * 60 * 1000L;
    if (!recent || !NowPlaying.hasSong || !lockPlayerOn(this) || LockActivity.showing) return;
    android.app.KeyguardManager km = getSystemService(android.app.KeyguardManager.class);
    if (km == null || !km.isKeyguardLocked()) return;
    Intent i = new Intent(this, LockActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
    NotificationManager nm = getSystemService(NotificationManager.class);
    boolean fsi = Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent();
    if (fsi) {
      // A full-screen notification is how Android lets an app open its own
      // screen over the lock screen; it's removed as soon as the player shows.
      PendingIntent pi = PendingIntent.getActivity(this, 50, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
      Notification n = new NotificationCompat.Builder(this, LOCK_CHANNEL)
          .setSmallIcon(R.drawable.ic_note)
          .setContentTitle(NowPlaying.title.isEmpty() ? "Wavelength" : NowPlaying.title)
          .setContentText(NowPlaying.artist)
          .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
          .setPriority(NotificationCompat.PRIORITY_HIGH)
          .setOnlyAlertOnce(true)
          .setAutoCancel(true)
          .setTimeoutAfter(5000)
          .setFullScreenIntent(pi, true)
          .build();
      try { nm.notify(LOCK_ID, n); } catch (Exception e) { Log.w(MainActivity.TAG, "lock player: " + e); }
    } else {
      try { startActivity(i); } catch (Exception e) { Log.w(MainActivity.TAG, "lock player: " + e); }
    }
  }

  static void cancelLockLaunch(Context c) {
    try { c.getSystemService(NotificationManager.class).cancel(LOCK_ID); } catch (Exception e) { /* gone */ }
  }

  // ------------------------------------------------------------ notification
  PendingIntent openIntent() {
    return PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).putExtra("openPlayer", true)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
  }

  Notification build() {
    boolean playing = NowPlaying.playing;
    NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_note)
        .setContentTitle(NowPlaying.title.isEmpty() ? "Wavelength" : NowPlaying.title)
        .setContentText(NowPlaying.artist)
        .setSubText(NowPlaying.roomLine.isEmpty() ? null : NowPlaying.roomLine)
        .setLargeIcon(NowPlaying.art)
        .setContentIntent(openIntent())
        .setOngoing(playing)
        .setSilent(true)
        .setShowWhen(false)
        .setColorized(true)
        .setColor(NowPlaying.color)
        .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .addAction(NowPlaying.liked ? R.drawable.ic_heart_on : R.drawable.ic_heart, NowPlaying.liked ? "Unlike" : "Like", action("wl.like", 4))
        .addAction(R.drawable.ic_prev, "Previous", action("wl.prev", 1))
        .addAction(playing ? R.drawable.ic_pause : R.drawable.ic_play, playing ? "Pause" : "Play", action("wl.toggle", 2))
        .addAction(R.drawable.ic_next, "Next", action("wl.next", 3))
        .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
            .setMediaSession(session.getSessionToken())
            .setShowActionsInCompactView(1, 2, 3));
    if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
    return b.build();
  }

  PendingIntent action(String a, int code) {
    return PendingIntent.getService(this, code, new Intent(this, PlaybackService.class).setAction(a), PendingIntent.FLAG_IMMUTABLE);
  }

  @Override
  public void onTaskRemoved(Intent rootIntent) {
    // Swiped away from recents: stop like any music app.
    MainActivity m = MainActivity.live;
    if (m != null) m.engineCall(0, "cmd", "pause", null);
    stopSelf();
  }

  @Override
  public void onDestroy() {
    NowPlaying.removeListener(this);
    try { unregisterReceiver(receiver); } catch (Exception e) { /* not registered */ }
    if (cpu.isHeld()) cpu.release();
    if (wifi.isHeld()) wifi.release();
    session.release();
    inst = null;
    super.onDestroy();
  }

  @Override public IBinder onBind(Intent i) { return null; }
}
