#!/usr/bin/env python3
"""Capture paired baseline/candidate screenshots in one Chromium process.

Screenshots and browser profiles are written only to the caller-provided output
folder, which should live outside the repository. The script does not make any
external network request other than the two caller-provided local HTTP origins.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import signal
import socket
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import requests
import websocket

ROUTES = [
    "/en",
    "/zh-hant",
    "/en/privacy",
    "/zh-hant/privacy",
    "/en/services/seo-geo-growth-system",
    "/zh-hant/services/seo-geo-growth-system",
    "/en/methodology/journey-intelligence",
    "/zh-hant/methodology/journey-intelligence",
    "/en/glossary/geo",
    "/zh-hant/glossary/geo",
    "/en/publications/what-a-public-website-can-tell-you",
    "/zh-hant/publications/what-a-public-website-can-tell-you",
]
VIEWPORTS = {"desktop": (1440, 1000), "mobile": (390, 844)}
READY_EXPRESSION = r"""
(async () => {
  const css = document.createElement('style');
  css.dataset.visualParity = 'true';
  css.textContent = `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }`;
  document.head.append(css);
  document.documentElement.classList.add('visual-parity-capture');
  window.scrollTo(0, 0);
  await document.fonts.ready;
  await Promise.all([
    document.fonts.load('400 16px "Noto Sans TC"', '公開網站內容'),
    document.fonts.load('700 16px "Noto Sans TC"', '公開網站內容'),
    document.fonts.load('700 23.2px "Noto Serif TC"', '讓我們先說清楚 Cookie。'),
    document.fonts.load('400 12px "DM Mono"', 'DISCOVERYSTACK'),
  ]);
  const started = performance.now();
  while (!document.querySelector('.cookie-copy h2') && performance.now() - started < 3000) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const cookieHeading = document.querySelector('.cookie-copy h2');
  if (cookieHeading) await document.fonts.load(getComputedStyle(cookieHeading).font, cookieHeading.textContent || '');
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise(resolve => setTimeout(resolve, 700));
  return {
    readyState: document.readyState,
    fonts: document.fonts.status,
    cookieHeading: Boolean(cookieHeading),
    scrollY: window.scrollY,
  };
})()
"""


def rpc(ws: websocket.WebSocket, state: dict[str, int], method: str, params: dict | None = None) -> dict:
    state["id"] += 1
    request_id = state["id"]
    ws.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
    while True:
        message = json.loads(ws.recv())
        if message.get("id") == request_id:
            if "error" in message:
                raise RuntimeError(message["error"])
            return message


def wait_for_page(port: int) -> dict:
    for _ in range(100):
        try:
            pages = requests.get(f"http://127.0.0.1:{port}/json/list", timeout=1).json()
            page = next(item for item in pages if item.get("type") == "page")
            return page
        except Exception:
            time.sleep(0.1)
    raise RuntimeError(f"Chromium DevTools page did not start on port {port}")


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return int(sock.getsockname()[1])


def capture_viewport(name: str, width: int, height: int, baseline_url: str, candidate_url: str, output: Path) -> None:
    profile = tempfile.mkdtemp(prefix=f"astro-public-private-{name}-")
    port = free_port()
    process = subprocess.Popen(
        [
            "chromium", "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
            f"--remote-debugging-port={port}", f"--remote-allow-origins=http://127.0.0.1:{port}",
            f"--user-data-dir={profile}", "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        page = wait_for_page(port)
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=40)
        state = {"id": 0}
        rpc(ws, state, "Page.enable")
        rpc(ws, state, "Runtime.enable")
        rpc(ws, state, "Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": 1, "mobile": False,
        })
        rpc(ws, state, "Emulation.setEmulatedMedia", {
            "features": [{"name": "prefers-reduced-motion", "value": "reduce"}],
        })
        for site, origin in (("baseline", baseline_url), ("candidate", candidate_url)):
            for route in ROUTES:
                slug = route.strip("/").replace("/", "-")
                rpc(ws, state, "Page.navigate", {"url": urljoin(origin.rstrip("/") + "/", route.lstrip("/"))})
                ready = {}
                for _ in range(60):
                    result = rpc(ws, state, "Runtime.evaluate", {
                        "expression": READY_EXPRESSION, "awaitPromise": True, "returnByValue": True,
                    })
                    ready = result.get("result", {}).get("result", {}).get("value", {})
                    if ready.get("scrollY") == 0 and ready.get("fonts") == "loaded" and "cookieHeading" in ready:
                        break
                    time.sleep(0.1)
                else:
                    raise RuntimeError(f"unstable capture readiness for {site} {name} {route}: {ready}")
                screenshot = rpc(ws, state, "Page.captureScreenshot", {"format": "png", "fromSurface": True})
                (output / f"{site}-{name}-{slug}.png").write_bytes(base64.b64decode(screenshot["result"]["data"]))
        ws.close()
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
        # The temporary profile is intentionally outside the repository.
        subprocess.run(["rm", "-rf", profile], check=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-url", required=True)
    parser.add_argument("--candidate-url", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    chromium = subprocess.check_output(["chromium", "--version"], text=True).strip()
    for name, (width, height) in VIEWPORTS.items():
        capture_viewport(name, width, height, args.baseline_url, args.candidate_url, args.output)
    (args.output / "capture-metadata.json").write_text(json.dumps({
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "baselineUrl": args.baseline_url,
        "candidateUrl": args.candidate_url,
        "chromium": chromium,
        "viewports": VIEWPORTS,
        "routes": ROUTES,
        "fontWait": ["document.fonts.ready", "Noto Sans TC", "Noto Serif TC", "DM Mono"],
        "animationStrategy": "prefers-reduced-motion=reduce plus injected animation/transition/caret disable CSS",
        "settle": "two requestAnimationFrame calls plus 700ms",
        "scrollY": 0,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"captured={len(list(args.output.glob('*.png')))}")


if __name__ == "__main__":
    main()
