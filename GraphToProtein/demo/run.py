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
    args=parser.parse_args()
    if not 0 <= args.port_offset <= 61357:
        parser.error("invalid port offset")
    if args.browser or args.no_browser or args.stop or args.port_offset:
        serve(4178+args.port_offset,args.no_browser,args.stop)
    else:
        open_studio()
