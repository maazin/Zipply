/// <reference types="vite/client" />

// CRXJS: importing a content script with ?script gives its output path, for
// chrome.scripting.executeScript.
declare module '*?script' {
  const path: string
  export default path
}
