// Aplica o tema salvo antes de desenhar a página (evita piscar). Arquivo próprio: a CSP não permite script embutido.
try {
  if (localStorage.getItem("petsos:theme") === "dark") {
    document.documentElement.dataset.theme = "dark";
    document.querySelector('meta[name="theme-color"]').content = "#2B1650";
  }
} catch (e) { /* navegação privada: fica o tema claro */ }
