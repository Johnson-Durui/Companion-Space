import "../../src/styles/theme.css";
import "../../src/styles/base.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { scheduleFontPrefetch } from "../../src/styles/prefetch-fonts";
import { UiGallery } from "./UiGallery";

scheduleFontPrefetch();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UiGallery />
  </StrictMode>,
);
