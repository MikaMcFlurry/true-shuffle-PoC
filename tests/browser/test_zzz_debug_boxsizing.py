from __future__ import annotations

import pytest

pytestmark = pytest.mark.browser


def test_debug_boxsizing_root_cause(page):
    page.goto("/library", wait_until="networkidle")
    result = page.evaluate(
        """() => {
             const el = document.querySelector('#runName');
             const matched = [];
             for (const sheet of document.styleSheets) {
               let rules;
               try { rules = sheet.cssRules; } catch (e) { continue; }
               for (const rule of rules) {
                 if (rule.selectorText && el.matches(rule.selectorText)) {
                   if (rule.style.boxSizing || rule.selectorText.includes('*')) {
                     matched.push({ selector: rule.selectorText, boxSizing: rule.style.boxSizing });
                   }
                 }
               }
             }
             return { matched, computed: getComputedStyle(el).boxSizing };
           }"""
    )
    import json
    print(json.dumps(result, indent=2))
