package io.github.orionvw42.wavelength;

import android.net.Uri;

/**
 * Network-level blocking of ad and ad-tracking requests from YouTube Music.
 * The ads themselves are removed by bridge.js (it strips them from YouTube's
 * responses, and mutes + skips any that slip through); this just stops the ad
 * servers and ad beacons from being contacted at all.
 */
final class AdBlock {
  private static final String[] HOSTS = {
      "doubleclick.net", "googlesyndication.com", "googleadservices.com", "imasdk.googleapis.com",
      "googletagservices.com", "adservice.google.com",
  };
  private static final String[] PATHS = {
      "/pagead/", "/api/stats/ads", "/ptracking", "/get_midroll_", "/api/stats/atr",
  };

  static boolean blocked(Uri u) {
    String host = u.getHost();
    if (host == null) return false;
    for (String h : HOSTS) if (host.equals(h) || host.endsWith("." + h)) return true;
    if (host.endsWith("youtube.com")) {
      String path = u.getPath() == null ? "" : u.getPath();
      for (String p : PATHS) if (path.startsWith(p)) return true;
    }
    return false;
  }

  private AdBlock() {}
}
