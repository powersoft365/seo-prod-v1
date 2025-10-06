"use client";

import { useEffect } from "react";

/**
 * Global beforeunload guard.
 * - Shows the confirmation dialog by default.
 * - Skips the dialog if sessionStorage.suppressBeforeUnload === "1"
 *   (we set this just before sending the user to Wallee).
 */
export default function BeforeUnloadPrompt({
  enabled = true,
  message = "Are you sure you want to leave?",
}) {
  // Clear any stale suppression flag on fresh loads (e.g., when user comes back from Wallee)
  useEffect(() => {
    try {
      if (sessionStorage.getItem("suppressBeforeUnload") === "1") {
        sessionStorage.removeItem("suppressBeforeUnload");
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const handleBeforeUnload = (event) => {
      // If a flow explicitly suppressed the prompt (e.g., Wallee checkout), do nothing.
      try {
        if (sessionStorage.getItem("suppressBeforeUnload") === "1") {
          return;
        }
      } catch {}

      // Otherwise, show the standard confirmation dialog.
      event.preventDefault();
      event.returnValue = message; // Needed for Chrome
      return message; // For older browsers
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [enabled, message]);

  return null;
}
