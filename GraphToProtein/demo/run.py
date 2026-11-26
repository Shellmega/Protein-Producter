"""Start the desktop sketch editor or its local browser interface."""
import argparse
from model_window import open_studio
from model_server import serve

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", action="store_true")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--stop", action="store_true")
    parser.add_argument("--port-offset", type=int, default=0)
    parser.add_argument("--prepare-model", action="store_true", help="install and check model assets without opening a window")
    parser.add_argument("--check-startup", action="store_true", help="open, initialize and close the drawing window")
    args=parser.parse_args()
    if args.prepare_model:
        from model_setup import ensure_model
        ensure_model(lambda msg: print(msg,flush=True))
        raise SystemExit(0)
    if args.check_startup:
        import tkinter as tk
        from model_window import Studio, ROOT
        window=tk.Tk()
        gui=Studio(window,ROOT/"local/gtp-model-desktop/jobs",ROOT/"GraphToProtein.html")
        window.update()
        assert window.winfo_ismapped() and gui.canvas.winfo_width()>1
        print("Studio window ready:",window.title(),flush=True)
        window.destroy()
        gui.pool.shutdown()
        raise SystemExit(0)
    if not 0 <= args.port_offset <= 61357:
        parser.error("invalid port offset")
    if args.browser or args.no_browser or args.stop or args.port_offset:
        serve(4178+args.port_offset,args.no_browser,args.stop)
    else:
        open_studio()
