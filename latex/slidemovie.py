#!/usr/bin/env python3
"""slidemovie: present beamer PDFs with movies that actually play.

  slidemovie.py present deck.pdf [--root DIR] [--port N] [--no-open]
      Serve the deck on 127.0.0.1 and open the viewer in the browser.
      Movie files are looked up relative to the PDF; they must sit under
      --root (default: the PDF's folder).

  slidemovie.py posters deck.tex [--force]
      After a LaTeX run, make every poster the deck asks for (frame=first,
      middle, last or a time), then run LaTeX again.

  slidemovie.py poster movie.mp4 [--frame first|middle|last|S]
      Write movie.mp4.png (or movie.mp4.<frame>.png) by hand.

  slidemovie.py encode 'frames/*.png' -o movie.mp4 [--fps 10]
  slidemovie.py encode anim.gif -o anim.mp4
      Turn a frame sequence or GIF into an H.264 mp4 that every browser
      plays, then write its poster.

  slidemovie.py pack deck.pdf [-o NAME]
      Copy the PDF and every movie it plays into NAME/ and NAME.zip, to send.

  slidemovie.py list deck.pdf
      Print every movie the deck refers to and whether the file exists.

Nothing here needs network access; pdf.js is vendored in viewer/vendor.
"""
import argparse
import http.server
import mimetypes
import os
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import urllib.parse
import webbrowser
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
# the viewer lives in ../viewer in the repository (or next to this file)
VIEWER = next((d for d in (os.path.join(HERE, "..", "viewer"), os.path.join(HERE, "viewer"))
               if os.path.isdir(d)), os.path.join(HERE, "..", "viewer"))
VIEWER = os.path.realpath(VIEWER)

mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("video/mp4", ".m4v")
mimetypes.add_type("video/quicktime", ".mov")
mimetypes.add_type("video/webm", ".webm")
mimetypes.add_type("image/gif", ".gif")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")


def need_ffmpeg():
    exe = shutil.which("ffmpeg")
    if not exe:
        sys.exit("ffmpeg not found (brew install ffmpeg)")
    return exe


# --------------------------------------------------------------------- server
class Handler(http.server.BaseHTTPRequestHandler):
    """GET/HEAD with byte ranges (Safari will not play video without them).

    /viewer/...  -> the viewer folder next to this script
    /deck/...    -> files under the deck root
    """
    root = None
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if self.server.verbose:
            sys.stderr.write("  " + fmt % args + "\n")

    def resolve(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        for prefix, base in (("/viewer/", VIEWER), ("/deck/", self.root)):
            if path.startswith(prefix):
                rel = path[len(prefix):]
                full = os.path.realpath(os.path.join(base, rel))
                if full == base or full.startswith(base + os.sep):
                    return full
                return None
        return None

    def do_HEAD(self):
        self.send(head=True)

    def do_PUT(self):
        """Save speaker notes: only <deck>.pdf.notes.json next to an existing PDF."""
        full = self.resolve()
        n = int(self.headers.get("Content-Length") or 0)
        ok = (full and self.path.startswith("/deck/") and full.endswith(".pdf.notes.json")
              and os.path.isfile(full[: -len(".notes.json")]) and 0 < n <= 2_000_000)
        if not ok:
            self.send_error(403)
            return
        body = self.rfile.read(n)
        try:
            import json
            json.loads(body)
        except ValueError:
            self.send_error(400)
            return
        tmp = full + ".tmp"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, full)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.send(head=False)

    def send(self, head):
        if urllib.parse.urlsplit(self.path).path in ("/", ""):
            self.send_response(302)
            self.send_header("Location", self.server.start_url)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        full = self.resolve()
        if not full or not os.path.isfile(full):
            if full and self.path.startswith("/deck/"):
                sys.stderr.write(f"  missing: {full}\n")
            self.send_error(404)
            return
        size = os.path.getsize(full)
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        status = 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if m:
                a, b = m.groups()
                if a == "":
                    start, end = max(0, size - int(b)), size - 1
                else:
                    start = int(a)
                    end = min(int(b), size - 1) if b else size - 1
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-cache")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head:
            return
        try:
            with open(full, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the browser cancels video range requests all the time


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def present(args):
    pdf = os.path.realpath(args.pdf)
    if not os.path.isfile(pdf):
        sys.exit(f"no such file: {args.pdf}")
    root = os.path.realpath(args.root or os.path.dirname(pdf))
    if not (pdf.startswith(root + os.sep)):
        sys.exit("--root must contain the PDF")
    report_movies(pdf, quiet_ok=True)
    Handler.root = root
    srv = Server(("127.0.0.1", args.port), Handler)
    srv.verbose = args.verbose
    port = srv.server_address[1]
    rel = urllib.parse.quote(os.path.relpath(pdf, root))
    srv.start_url = f"/viewer/index.html?pdf=/deck/{rel}"
    url = f"http://127.0.0.1:{port}{srv.start_url}"
    print(f"slidemovie: {url}")
    print("  f fullscreen, s presenter window, ? help; Ctrl-C here to stop")
    if not args.no_open:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print()


# ------------------------------------------------------------------ list
def movie_links(pdf):
    """(page, href) for each slidemovie link, read straight from the PDF.

    A rough scan (plain and Flate-compressed objects), good enough for
    checking files; the viewer itself uses pdf.js.
    """
    data = open(pdf, "rb").read()
    # pdfTeX puts annotations in compressed object streams: inflate them too.
    chunks = [data]
    for m in re.finditer(rb"stream\r?\n", data):
        try:
            chunks.append(zlib.decompressobj().decompress(data[m.end():m.end() + (1 << 22)]))
        except zlib.error:
            pass
    data = b"\n".join(chunks)
    found = []
    for m in re.finditer(rb"/URI\s*\(((?:[^()\\]|\\.)*)\)", data):
        s = m.group(1).decode("latin-1")
        s = re.sub(r"\\(.)", r"\1", s)
        if "#slidemovie" in s:
            found.append(s)
    return found


def report_movies(pdf, quiet_ok=False):
    base = os.path.dirname(pdf)
    links = movie_links(pdf)
    seen = set()
    bad = 0
    for href in links:
        f = urllib.parse.unquote(href.split("#", 1)[0])
        if f in seen:
            continue
        seen.add(f)
        ok = os.path.isfile(os.path.join(base, f))
        bad += not ok
        if not (quiet_ok and ok):
            print(f"  {'ok     ' if ok else 'MISSING'} {f}")
    if quiet_ok:
        print(f"slidemovie: {len(seen)} movie file(s) in deck"
              + (f", {bad} MISSING" if bad else ""))
    return bad


def list_cmd(args):
    pdf = os.path.realpath(args.pdf)
    bad = report_movies(pdf)
    if not movie_links(pdf):
        print("  (no slidemovie links found, or the PDF uses compressed "
              "object streams; the viewer still finds them)")
    sys.exit(1 if bad else 0)


# ---------------------------------------------------------------- media
def duration(movie):
    """Length in seconds (ffprobe), or None."""
    probe = shutil.which("ffprobe")
    if not probe:
        return None
    r = subprocess.run([probe, "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", movie], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None


def poster(movie, frame="first", out=None, start=None, end=None):
    """Write the still frame that stands in for `movie`.

    frame: first | middle | last | <seconds>, within the start/end window.
    """
    ff = need_ffmpeg()
    if out is None:
        out = movie + (".png" if frame == "first" else f".{frame}.png")
    lo = float(start) if start not in (None, "") else 0.0
    hi = float(end) if end not in (None, "") else None
    # composite on white, like the PDF page under it (GIF transparency)
    flat = ["-filter_complex",
            "[0:v]format=rgba,split[a][b];[a]drawbox=c=white:t=fill[w];[w][b]overlay,format=rgb24"]
    if frame == "last" and hi is None:
        # decode the final second and keep the last frame written
        cmd = [ff, "-v", "error", "-y", "-sseof", "-1", "-i", movie, *flat, "-update", "1", out]
    else:
        if frame == "first":
            t = lo
        elif frame == "middle":
            d = hi if hi is not None else duration(movie)
            t = (lo + d) / 2 if d else lo
        elif frame == "last":
            t = max(lo, hi - 0.04)
        else:
            t = float(frame)
        cmd = [ff, "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", movie, *flat, "-frames:v", "1", out]
    subprocess.run(cmd, check=True)
    print(f"wrote {out}")
    return out


def poster_cmd(args):
    for m in args.movie:
        poster(m, args.frame)


def posters_cmd(args):
    """Make every poster a deck needs, from the <deck>.smv list LaTeX writes."""
    smv = args.deck
    for ext in (".tex", ".pdf"):
        if smv.endswith(ext):
            smv = smv[: -len(ext)]
    if not smv.endswith(".smv"):
        smv += ".smv"
    if not os.path.isfile(smv):
        sys.exit(f"no {smv}: run LaTeX once with \\usepackage{{slidemovie}} first")
    base = os.path.dirname(os.path.abspath(smv))
    seen, made, bad = set(), 0, 0
    for line in open(smv, encoding="utf-8", errors="replace"):
        parts = line.rstrip("\n").split("|")
        if len(parts) != 5 or tuple(parts) in seen:
            continue
        seen.add(tuple(parts))
        movie, frame, start, end, out = parts
        mpath, opath = os.path.join(base, movie), os.path.join(base, out)
        if not os.path.isfile(mpath):
            print(f"  MISSING movie {movie}")
            bad += 1
            continue
        if os.path.isfile(opath) and not args.force and os.path.getmtime(opath) >= os.path.getmtime(mpath):
            continue
        poster(mpath, frame or "first", opath, start, end)
        made += 1
    print(f"slidemovie: {made} poster(s) written" + (f", {bad} movie(s) missing" if bad else "")
          + ("; run LaTeX again" if made else ""))
    sys.exit(1 if bad else 0)


def encode_cmd(args):
    ff = need_ffmpeg()
    src = args.input
    cmd = [ff, "-v", "error", "-y"]
    if any(c in src for c in "*?["):
        cmd += ["-framerate", str(args.fps), "-pattern_type", "glob", "-i", src]
    else:
        cmd += ["-i", src]
    # yuv420p + even dimensions: plays in Safari, Chrome, Firefox, QuickTime.
    cmd += ["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,format=yuv420p",
            "-c:v", "libx264", "-crf", str(args.crf), "-preset", "slow",
            "-movflags", "+faststart", "-an", args.output]
    subprocess.run(cmd, check=True)
    print(f"wrote {args.output}")
    poster(args.output)


def pack_cmd(args):
    """Copy a deck PDF and every movie it plays into one folder (and zip it)."""
    pdf = os.path.realpath(args.pdf)
    base = os.path.dirname(pdf)
    movies = sorted({urllib.parse.unquote(h.split("#", 1)[0]) for h in movie_links(pdf)})
    name = args.output or os.path.splitext(os.path.basename(pdf))[0] + "-slidemovie"
    out = os.path.abspath(name)
    if os.path.exists(out) or os.path.exists(out + ".zip"):
        sys.exit(f"{out} (or .zip) exists; pick another -o")
    # keep the relative layout; movies above the PDF's folder pull the PDF down a level
    rel = [os.path.normpath(m) for m in movies if not re.match(r"^[a-z]+:", m, re.I)]
    up = max([m.split(os.sep).count("..") for m in rel] + [0])
    pdf_dir = os.path.join(out, *[f"deck{i}" for i in range(up)]) if up else out
    os.makedirs(pdf_dir)
    shutil.copy2(pdf, pdf_dir)
    if os.path.isfile(pdf + ".notes.json"):
        shutil.copy2(pdf + ".notes.json", pdf_dir)     # speaker notes travel with the deck
    bad = 0
    for m in rel:
        src = os.path.normpath(os.path.join(base, m))
        dst = os.path.normpath(os.path.join(pdf_dir, m))
        if not os.path.isfile(src):
            print(f"  MISSING {m}")
            bad += 1
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
    with open(os.path.join(out, "README.txt"), "w") as f:
        f.write("Open the PDF with Slidemovie.app (File > Open, or drag it onto the app)\n"
                "so the movies play. Any other PDF viewer shows still frames.\n"
                "Keep the folders as they are: the movies are found next to the PDF.\n")
    shutil.make_archive(out, "zip", os.path.dirname(out), os.path.basename(out))
    size = os.path.getsize(out + ".zip") / 1e6
    print(f"packed {len(rel) - bad} movie(s) + PDF into {out}/ and {out}.zip ({size:.1f} MB)")
    sys.exit(1 if bad else 0)


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("present", help="show a deck in the browser")
    a.add_argument("pdf")
    a.add_argument("--root", help="folder served to the viewer (default: PDF's folder)")
    a.add_argument("--port", type=int, default=0)
    a.add_argument("--no-open", action="store_true")
    a.add_argument("-v", "--verbose", action="store_true")
    a.set_defaults(fn=present)
    a = sub.add_parser("poster", help="write <movie>.png (or <movie>.<frame>.png)")
    a.add_argument("movie", nargs="+")
    a.add_argument("--frame", default="first", help="first, middle, last, or seconds")
    a.set_defaults(fn=poster_cmd)
    a = sub.add_parser("posters", help="make every missing poster a deck needs (after a LaTeX run)")
    a.add_argument("deck", help="deck.tex, deck.pdf, or deck.smv")
    a.add_argument("--force", action="store_true", help="remake posters that already exist")
    a.set_defaults(fn=posters_cmd)
    a = sub.add_parser("encode", help="frames or GIF -> mp4 (+ poster)")
    a.add_argument("input", help="a GIF/movie, or a quoted glob like 'frames/*.png'")
    a.add_argument("-o", "--output", required=True)
    a.add_argument("--fps", type=float, default=10)
    a.add_argument("--crf", type=int, default=18)
    a.set_defaults(fn=encode_cmd)
    a = sub.add_parser("pack", help="copy a deck and its movies into one folder + zip, to send")
    a.add_argument("pdf")
    a.add_argument("-o", "--output", help="folder name (default: <deck>-slidemovie)")
    a.set_defaults(fn=pack_cmd)
    a = sub.add_parser("list", help="check the movie files a deck needs")
    a.add_argument("pdf")
    a.set_defaults(fn=list_cmd)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
