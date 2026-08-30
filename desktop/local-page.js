/**
 * Is this URL one of our own pages?
 *
 * The comparison is a plain prefix check against the `file://` URL of `desktop/ui/`, and it
 * used to be case-sensitive everywhere. On Windows that denied every permission to our own
 * pages whenever the app was launched from a lower-case path: `pathToFileURL` keeps the drive
 * letter as the process saw it (`file:///d:/streamer/...`) while Chromium reports the page as
 * `file:///D:/streamer/...`. Windows paths are case-insensitive, so the comparison is too --
 * there, and only there. The prefix semantics are unchanged.
 */
export function isLocalPageUrl(url, prefix, platform = process.platform) {
  if (typeof url !== 'string' || typeof prefix !== 'string' || prefix === '') return false;
  if (platform !== 'win32') return url.startsWith(prefix);
  return url.toLowerCase().startsWith(prefix.toLowerCase());
}
