// Jost: a Futura-like geometric, the type of 1950s German program magazines.
// It is also the face of the cast brass emblem on the cloth. Barlow
// Condensed: the condensed caps printed on the dial glass and engraved on
// keys and plates.
import "@fontsource-variable/jost/wght.css";
import "@fontsource/barlow-condensed/latin-500.css";
import "@fontsource/barlow-condensed/latin-600.css";
import "./styles.css";
import { render } from "preact";
import { App } from "./app";
import { onLink } from "./router";
import { applyIllumination } from "./store";

applyIllumination();
document.addEventListener("click", onLink);
render(<App />, document.getElementById("app")!);
