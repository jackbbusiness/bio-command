/* Theme bootstrap: runs before CSS paint to avoid a dark flash in day mode */
try {
  if (window.localStorage.getItem("biocommand.theme") === "light") {
    document.documentElement.dataset.theme = "light";
  }
} catch (e) {}
