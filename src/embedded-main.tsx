import { createRoot } from "react-dom/client";
import App from "./App";
import { connectEmbedded } from "./embedded";
import "./styles.css";
const root = createRoot(document.getElementById("root")!);
connectEmbedded().then(() => root.render(<App />)).catch(() => {
  root.render(<div className="empty-state" role="alert"><h2>Could not connect to the app host.</h2><p>Open TasknBoard again from the connected plugin.</p></div>);
});
