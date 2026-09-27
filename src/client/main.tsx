import "@fontsource-variable/overpass/wght.css";
// Doto with both axes: weight sets the dot size, ROND makes the dots round.
import "@fontsource-variable/doto/full.css";
import "./styles.css";
import { render } from "preact";
import { App } from "./app";
import { onLink } from "./router";
import { applyIllumination } from "./store";

applyIllumination();
document.addEventListener("click", onLink);
render(<App />, document.getElementById("app")!);
