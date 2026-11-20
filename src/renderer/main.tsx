import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { ComposeWindowApp } from "./features/compose/ComposeWindowApp.tsx";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) throw new Error("Renderer root element #root is missing");

// The same renderer serves the pop-out compose windows; main opens those with
// ?window=compose.
const isComposeWindow = new URLSearchParams(window.location.search).get("window") === "compose";

createRoot(container).render(
  <StrictMode>{isComposeWindow ? <ComposeWindowApp /> : <App />}</StrictMode>,
);
