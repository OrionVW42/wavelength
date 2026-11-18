package io.github.orionvw42.wavelength;

/** Build switches. WEBVIEW_DEBUG is only on in test builds (gradle -Pwldebug). */
final class BuildInfo {
  static final boolean DEBUG = BuildConfig.WEBVIEW_DEBUG;
  private BuildInfo() {}
}
