// The list of videos on the page, and one button each.

const list = document.getElementById("list");
const clock = (s) => (s == null ? "" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);

function render(videos) {
  if (!videos.length) {
    list.textContent = "No video on this page. Open one and try again.";
    return;
  }
  list.replaceChildren(...videos.map((v) => {
    const item = document.createElement("div");
    item.className = `item${v.src ? "" : " cant"}`;
    const title = document.createElement("b");
    title.textContent = v.title;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = [clock(v.seconds), v.width ? `${v.width}×${v.height}` : ""].filter(Boolean).join(" · ");
    const button = document.createElement("button");
    button.textContent = v.src ? "Dub this video" : "Cannot take this one";
    button.disabled = !v.src;
    if (v.src) {
      button.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "open-dub", src: v.src, name: v.title }, () => window.close());
      });
    }
    item.append(title, meta, button);
    if (!v.src) {
      const why = document.createElement("div");
      why.className = "meta";
      why.style.marginTop = "6px";
      // Saying which sites and why, so it does not read as a fault.
      why.textContent = "This site builds its video in the page from thousands of pieces, so there is no file to take yet.";
      item.append(why);
    }
    return item;
  }));
}

// Sites that build their video in the page — YouTube and most of the big
// ones — have no file to take, and until now the popup said so and stopped
// there. Dubbing a video of your own never depended on the page at all.
document.getElementById("own").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "open-dub" }, () => window.close());
});

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "list" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      list.textContent = "OpenDub cannot read this page. Try a normal web page.";
      return;
    }
    render(res.videos);
  });
});
