import "@fontsource-variable/archivo/standard.css";
import "./styles.css";
import { render } from "preact";
import { App } from "./app";
import { onLink } from "./router";
import { applyIllumination } from "./store";

applyIllumination();
document.addEventListener("click", onLink);
render(<App />, document.getElementById("app")!);
