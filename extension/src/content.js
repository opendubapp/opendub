// What is playing on this page, and can OpenDub get at it?
//
// Two kinds of video live on the web. One is a file — <video src="…mp4"> —
// which can be fetched whole. The other is assembled in JavaScript from
// thousands of fragments (MSE, which is YouTube and most streaming sites),
// where `src` is a blob: URL meaning nothing outside the page and there is no
// file to take. The popup has to tell them apart, because only the first can
// be dubbed today, and saying so beats failing later.

function videos() {
  // Anything that is really a player: waiting for metadata would hide the very
  // videos we most need to explain — a streaming site's player sits at
  // readyState 0 until it is played, and "no video on this page" would be a
  // lie the reader cannot act on.
  return [...document.querySelectorAll("video")]
    .filter((v) => v.currentSrc || v.src || v.readyState > 0 || v.clientWidth > 120)
    .map((v, i) => ({
      index: i,
      seconds: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
      width: v.videoWidth,
      height: v.videoHeight,
      src: /^https?:/.test(v.currentSrc || "") ? v.currentSrc : null,   // null: built in the page
      title: (document.title || "video").slice(0, 80),
    }));
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type !== "list") return false;
  reply({ videos: videos(), page: location.href });
  return true;
});
