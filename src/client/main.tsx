// Jost: a Futura-like geometric, the type of 1950s German program magazines.
// Barlow Condensed: the condensed caps printed on the dial glass and engraved
// on keys and plates. Yellowtail: the script on the brass badge.
import "@fontsource-variable/jost/wght.css";
import "@fontsource/barlow-condensed/latin-500.css";
import "@fontsource/barlow-condensed/latin-600.css";
import "@fontsource/yellowtail/latin-400.css";
import "./styles.css";
import { render } from "preact";
import { App } from "./app";
import { onLink } from "./router";
import { applyIllumination } from "./store";

applyIllumination();
document.addEventListener("click", onLink);
render(<App />, document.getElementById("app")!);
