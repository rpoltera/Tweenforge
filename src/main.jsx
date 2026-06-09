import { createRoot } from "react-dom/client";
import App from "./AnimationStudio.jsx";

/* The component was written for Claude's artifact runtime, which provides a
   window.storage API. Outside that runtime we back it with localStorage so the
   exact same component code runs unchanged. */
if (!window.storage) {
  window.storage = {
    async get(key) {
      const v = localStorage.getItem(key);
      return v === null ? null : { key, value: v };
    },
    async set(key, value) {
      localStorage.setItem(key, value);
      return { key, value };
    },
    async delete(key) {
      localStorage.removeItem(key);
      return { key, deleted: true };
    },
    async list(prefix = "") {
      return { keys: Object.keys(localStorage).filter((k) => k.startsWith(prefix)) };
    },
  };
}

createRoot(document.getElementById("root")).render(<App />);
