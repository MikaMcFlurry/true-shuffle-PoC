// The client alone, its /api answered by each test (no Worker, no Spotify).
import config from "../../vite.config.ts";

export default { ...config, server: { host: "127.0.0.1", port: 8841, strictPort: true } };
