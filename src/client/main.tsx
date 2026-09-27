// Jost: a Futura-like geometric, the lettering of 1950s German radio dials
// and program magazines. Yellowtail: the brass script badge on the cloth.
import "@fontsource-variable/jost/wght.css";
import "@fontsource/yellowtail/latin-400.css";
import "./styles.css";
import { render } from "preact";
import { App } from "./app";
import { onLink } from "./router";
import { applyIllumination } from "./store";

applyIllumination();
document.addEventListener("click", onLink);
render(<App />, document.getElementById("app")!);
