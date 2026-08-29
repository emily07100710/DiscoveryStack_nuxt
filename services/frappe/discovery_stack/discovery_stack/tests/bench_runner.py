"""Stable bench entrypoint that preserves the original smoke traceback."""

import traceback

import frappe

from discovery_stack.tests.materialization_smoke import run as run_materialization_smoke


def run():
    try:
        return {"marker": "DISCOVERYSTACK_FRAPPE_SMOKE", **run_materialization_smoke()}
    except Exception as error:
        frappe.db.rollback()
        traceback.print_exc()
        return {
            "marker": "DISCOVERYSTACK_FRAPPE_SMOKE",
            "ok": False,
            "errorType": error.__class__.__name__[:96],
            "errorCode": "MATERIALIZATION_SMOKE_FAILED",
        }
