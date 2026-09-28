// The popup asks for the videos on the current tab, and opens the dubbing
// page for the one chosen. Nothing else lives here: the work happens in the
// extension's own page, where it can fetch the media and run the pipeline.

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "open-dub") {
    // The media host is not in the manifest — asking only when a video is
    // actually chosen keeps the install free of "read all your browsing".
    const origin = new URL(msg.src).origin + "/*";
    chrome.permissions.request({ origins: [origin] }, (granted) => {
      const page = chrome.runtime.getURL("dub.html") +
        `?src=${encodeURIComponent(msg.src)}&name=${encodeURIComponent(msg.name || "video")}` +
        `&granted=${granted ? 1 : 0}`;
      chrome.tabs.create({ url: page });
      reply({ opened: true, granted });
    });
    return true;
  }
  return false;
});
