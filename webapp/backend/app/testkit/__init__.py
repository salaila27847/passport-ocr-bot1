"""
Fake in-memory stand-ins for the Google Sheets/Drive API surfaces.

Lives under app/ (not tests/) because it's shared by two consumers: the pytest
suite (tests/test_sheets.py, tests/test_drive.py, tests/test_api.py) and
scripts/run_demo_server.py, which runs the real FastAPI app end-to-end for
manual/Playwright testing without needing live Google credentials. Not used
by any production code path.
"""
