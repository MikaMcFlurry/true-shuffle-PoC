import "@fontsource-variable/atkinson-hyperlegible-next/wght.css";
import "./styles/app.css";
import { render } from "preact";
import { App } from "./app";
import { onLink } from "./router";
import { applyIllumination } from "./store";
import { syncThemeColor } from "./theme";

// Earlier versions offered several designs; a remembered choice is simply ignored now.
applyIllumination();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncThemeColor);
document.addEventListener("click", onLink);
render(<App />, document.getElementById("app")!);
