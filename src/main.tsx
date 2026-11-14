import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { hostedPageFromSearch, nativeDesktop } from "./nativeWorkspaceLogic";
import "./styles.css";

const hostedPage = nativeDesktop() ? hostedPageFromSearch(window.location.search) : undefined;
if (hostedPage) document.body.classList.add("native-page-body");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App hostedPage={hostedPage} />
  </React.StrictMode>,
);
