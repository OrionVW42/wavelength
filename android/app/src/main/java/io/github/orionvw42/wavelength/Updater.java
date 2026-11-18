package io.github.orionvw42.wavelength;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * In-app updates: the UI finds a newer Wavelength-Android-<v>.apk on the
 * GitHub release page; this downloads it and hands it to Android's installer.
 * Android asks the user to confirm (and the first time, to allow Wavelength to
 * install apps). Updates must be signed with the same key as the installed app.
 */
final class Updater {
  static final String ACTION = "io.github.orionvw42.wavelength.INSTALL_STATUS";
  private static boolean busy;

  static void install(MainActivity a, String url, String version) {
    if (busy || url == null || !url.startsWith("https://github.com/OrionVW42/wavelength/releases/download/")) return;
    busy = true;
    new Thread(() -> {
      try {
        a.toUi(MainActivity.obj("t", "update", "phase", "downloading", "pct", 0, "version", version));
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        long total = c.getContentLengthLong();
        PackageInstaller pi = a.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        int id = pi.createSession(params);
        try (PackageInstaller.Session s = pi.openSession(id); InputStream in = c.getInputStream()) {
          try (OutputStream out = s.openWrite("wavelength.apk", 0, total > 0 ? total : -1)) {
            byte[] b = new byte[65536];
            long done = 0;
            int lastPct = -1;
            for (int r; (r = in.read(b)) > 0; ) {
              out.write(b, 0, r);
              done += r;
              int pct = total > 0 ? (int) (done * 100 / total) : 0;
              if (pct != lastPct && pct % 5 == 0) {
                lastPct = pct;
                a.toUi(MainActivity.obj("t", "update", "phase", "downloading", "pct", pct, "version", version));
              }
            }
            s.fsync(out);
          }
          Context ctx = a.getApplicationContext();
          BroadcastReceiver rx = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c2, Intent i) {
              int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
              if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) {
                  confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                  c2.startActivity(confirm);
                }
                return;
              }
              busy = false;
              try { c2.unregisterReceiver(this); } catch (Exception e) { /* gone */ }
              a.toUi(MainActivity.obj("t", "update", "phase", status == PackageInstaller.STATUS_SUCCESS ? "done" : "failed",
                  "error", i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)));
            }
          };
          if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(rx, new IntentFilter(ACTION), Context.RECEIVER_NOT_EXPORTED);
          else ctx.registerReceiver(rx, new IntentFilter(ACTION));
          PendingIntent cb = PendingIntent.getBroadcast(ctx, id, new Intent(ACTION).setPackage(ctx.getPackageName()),
              PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0));
          a.toUi(MainActivity.obj("t", "update", "phase", "installing", "version", version));
          s.commit(cb.getIntentSender());
        }
      } catch (Exception e) {
        busy = false;
        Log.w(MainActivity.TAG, "update: " + e);
        a.toUi(MainActivity.obj("t", "update", "phase", "failed", "error", String.valueOf(e.getMessage())));
      }
    }).start();
  }

  private Updater() {}
}
