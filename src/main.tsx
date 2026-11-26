import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import {ErrorNotifications, NativeErrorNotification} from "./ErrorNotifications";
import { hostedPageFromSearch, nativeDesktop } from "./nativeWorkspaceLogic";
import "./styles.css";
import "./buttons.css";

const notification = nativeDesktop() && new URLSearchParams(window.location.search).has("notification");
if(notification) document.body.classList.add("notification-body");
const hostedPage = nativeDesktop() ? hostedPageFromSearch(window.location.search) : undefined;
if (hostedPage) document.body.classList.add("native-page-body");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {notification ? <NativeErrorNotification/> : <><App hostedPage={hostedPage}/>{!nativeDesktop()&&<ErrorNotifications/>}</>}
  </React.StrictMode>,
);
