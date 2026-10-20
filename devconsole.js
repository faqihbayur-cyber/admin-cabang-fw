(function () {
  const mount = document.getElementById("devConsoleMount");
  if (!mount) return;

  let erudaLoaded = false;
  let visible = false;

  // ===== SVG ICON =====
  const icon = `
    <svg xmlns="http://www.w3.org/2000/svg"
         viewBox="0 0 24 24"
         fill="none"
         stroke="currentColor"
         stroke-width="1.5">

      <path stroke-linecap="round"
            stroke-linejoin="round"
            d="M4 4h16v16H4z"/>

      <path stroke-linecap="round"
            stroke-linejoin="round"
            d="M8 9l3 3-3 3"/>

      <path stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 15h4"/>
    </svg>
  `;

  // ===== CREATE BUTTON =====
  const btn = document.createElement("button");
  btn.className = "dev-console-btn";
  btn.innerHTML = icon;

  mount.appendChild(btn);

  // ===== LOAD ERUDA =====
  function loadEruda() {
    return new Promise((resolve) => {
      if (window.eruda) return resolve();

      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/eruda";
      script.onload = () => {
        eruda.init();
        eruda.hide();
        erudaLoaded = true;
        resolve();
      };
      document.body.appendChild(script);
    });
  }

  // preload (biar gak delay)
  window.addEventListener("load", loadEruda);

  // ===== TOGGLE =====
  btn.addEventListener("click", async () => {
    await loadEruda();

    if (!window.eruda) return;

    visible = !visible;

    if (visible) {
      eruda.show();
      console.log("Dev Console ON");
    } else {
      eruda.hide();
      console.log("Dev Console OFF");
    }
  });

})();