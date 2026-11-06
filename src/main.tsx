import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TeachPendant } from "./TeachPendant";
import { isTeachPath } from "./teachPendantLogic";
import "./styles.css";

const teach = isTeachPath(window.location.pathname);
if (teach) document.body.classList.add("teach-mode");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {teach ? <TeachPendant /> : <App />}
  </React.StrictMode>,
);
