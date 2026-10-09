"""Unit tests: shell parsing, path resolution, SQL classification, ledger integrity."""
import json
import os
import tempfile
import unittest

from kaaval import ALLOW, ASK, DENY, Guard, Ledger, Policy
from kaaval import shell, sql


def guard(**kw):
    ws = tempfile.mkdtemp(prefix="ws-")
    home = os.path.dirname(ws)
    return Guard(Policy(workspace=ws, home=home, **kw)), ws, home


class ShellParsing(unittest.TestCase):
    def test_compound_commands_are_all_inspected(self):
        g, ws, _ = guard()
        self.assertEqual(g.check("make clean && rm -rf /var/lib/app", cwd=ws).verdict, DENY)
        self.assertEqual(g.check("ls; rm -rf ~", cwd=ws).verdict, DENY)

    def test_wrappers_are_unwrapped(self):
        g, ws, _ = guard()
        for c in ['bash -c "rm -rf $HOME"', "sudo rm -rf /", "env X=1 rm -rf ~/Documents"]:
            self.assertEqual(g.check(c, cwd=ws).verdict, DENY, c)

    def test_dot_dot_escape(self):
        g, ws, _ = guard()
        self.assertEqual(g.check("rm -rf ../../", cwd=ws).verdict, DENY)

    def test_symlink_into_home_is_followed(self):
        g, ws, home = guard()
        os.symlink(home, os.path.join(ws, "innocent"))
        self.assertEqual(g.check("rm -rf innocent/", cwd=ws).verdict, DENY)

    def test_unresolvable_target_asks(self):
        g, ws, _ = guard()
        self.assertEqual(g.check("rm -rf $TARGET", cwd=ws).verdict, ASK)
        self.assertEqual(g.check("rm -rf $(cat list.txt)", cwd=ws).verdict, ASK)

    def test_redirects_are_writes(self):
        g, ws, _ = guard()
        self.assertEqual(g.check("echo x > notes.txt", cwd=ws).verdict, ALLOW)
        self.assertEqual(g.check("echo x > ~/.bashrc", cwd=ws).verdict, DENY)
        self.assertEqual(g.check("make 2>/dev/null", cwd=ws).verdict, ALLOW)

    def test_find_delete_and_git_clean(self):
        g, ws, _ = guard()
        self.assertEqual(g.check("find / -name '*.log' -delete", cwd=ws).verdict, DENY)
        self.assertEqual(g.check("find . -name '*.pyc' -delete", cwd=ws).verdict, ALLOW)

    def test_workspace_root_wipe_asks(self):
        g, ws, _ = guard()
        self.assertEqual(g.check("rm -rf .", cwd=ws).verdict, ASK)

    def test_read_only_commands_pass(self):
        g, ws, _ = guard()
        for c in ["ls -la ~", "cat /etc/hosts", "git status", "grep -r TODO ."]:
            self.assertEqual(g.check(c, cwd=ws).verdict, ALLOW, c)

    def test_windows_remove_item(self):
        g, ws, _ = guard()
        self.assertEqual(g.check("Remove-Item -Recurse -Force C:\\Users", cwd=ws).verdict, DENY)


class Environments(unittest.TestCase):
    def test_word_boundaries(self):
        g, ws, _ = guard()
        # 'products' is not 'prod'.
        self.assertEqual(g.check({"tool": "sql", "target": "postgres://db/app", "query": "DELETE FROM products WHERE id=3"}).verdict, ALLOW)

    def test_prod_session_may_touch_prod(self):
        g, ws, _ = guard(env="production", other_envs=["staging", "production"])
        self.assertEqual(g.check({"tool": "sql", "target": "postgres://prod-db/app", "query": "UPDATE t SET a=1 WHERE id=2"}).verdict, ALLOW)

    def test_reading_another_environment_asks(self):
        g, _, _ = guard()
        self.assertEqual(g.check({"tool": "sql", "target": "postgres://prod-db/app", "query": "SELECT * FROM t"}).verdict, ASK)


class Sql(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(sql.classify("DROP TABLE x"), "destroy")
        self.assertEqual(sql.classify("delete from x"), "destroy")
        self.assertEqual(sql.classify("DELETE FROM x WHERE id = 1"), "write")
        self.assertEqual(sql.classify("SELECT * FROM x"), "read")

    def test_comments_and_strings_cannot_hide_a_where(self):
        self.assertEqual(sql.worst("DELETE FROM x -- WHERE id=1"), "destroy")
        self.assertEqual(sql.worst("DELETE FROM x WHERE name = 'a; DROP TABLE y'"), "write")

    def test_multi_statement(self):
        self.assertEqual(sql.worst("SELECT 1; TRUNCATE logs"), "destroy")

    def test_unbounded_delete_asks_in_dev(self):
        g, _, _ = guard()
        self.assertEqual(g.check({"tool": "sql", "target": "postgres://db/app", "query": "DELETE FROM sessions"}).verdict, ASK)


class Chain(unittest.TestCase):
    def test_failed_read_does_not_stop_the_chain(self):
        g, ws, _ = guard()
        g.record("ls /nonexistent", ok=False, mutating=False)
        self.assertEqual(g.check("rm -rf build", cwd=ws).verdict, ALLOW)

    def test_failed_write_does(self):
        g, ws, _ = guard()
        g.record("mkdir out", ok=False, mutating=True)
        self.assertEqual(g.check("rm -rf build", cwd=ws).verdict, DENY)
        self.assertEqual(g.check("ls", cwd=ws).verdict, ALLOW)


class ClaudeCodeHook(unittest.TestCase):
    def test_bash_tool_call(self):
        from kaaval.hooks import claude_code
        g, ws, _ = guard()
        out = claude_code(g, {"tool_name": "Bash", "cwd": ws, "tool_input": {"command": "rm -rf tests/ ~/"}})
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("NA-01", out["hookSpecificOutput"]["permissionDecisionReason"])

    def test_write_outside_workspace(self):
        from kaaval.hooks import claude_code
        g, ws, home = guard()
        out = claude_code(g, {"tool_name": "Write", "cwd": ws, "tool_input": {"file_path": os.path.join(home, ".zshrc")}})
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_other_tools_pass_through(self):
        from kaaval.hooks import claude_code
        g, ws, _ = guard()
        self.assertEqual(claude_code(g, {"tool_name": "Read", "tool_input": {"file_path": "/etc/hosts"}}), {})


class LedgerIntegrity(unittest.TestCase):
    def test_tampering_is_detected(self):
        path = os.path.join(tempfile.mkdtemp(), "ledger.jsonl")
        led = Ledger(path)
        for i in range(4):
            led.append("decision", action=f"cmd {i}", verdict="ALLOW")
        self.assertTrue(Ledger(path).verify()[0])
        lines = open(path).read().splitlines()
        e = json.loads(lines[1]); e["verdict"] = "DENY"; lines[1] = json.dumps(e, sort_keys=True)
        open(path, "w").write("\n".join(lines) + "\n")
        ok, msg = Ledger(path).verify()
        self.assertFalse(ok)
        self.assertIn("entry 1", msg)

    def test_deleted_line_is_detected(self):
        path = os.path.join(tempfile.mkdtemp(), "ledger.jsonl")
        led = Ledger(path)
        for i in range(3):
            led.append("outcome", action=f"cmd {i}", ok=True)
        lines = open(path).read().splitlines()
        open(path, "w").write("\n".join([lines[0], lines[2]]) + "\n")
        self.assertFalse(Ledger(path).verify()[0])

    def test_state_survives_restart(self):
        ws = tempfile.mkdtemp()
        sd = os.path.join(ws, ".kaaval")
        Guard(Policy(workspace=ws), sd).freeze(True)
        g2 = Guard(Policy(workspace=ws), sd)
        self.assertTrue(g2.state.freeze)
        self.assertEqual(g2.check("rm -rf build", cwd=ws).verdict, DENY)



class EnvironmentAliases(unittest.TestCase):
    def test_prod_and_production_are_the_same_environment(self):
        import tempfile
        ws = tempfile.mkdtemp()
        g = Guard(Policy(workspace=ws, env="production", home=os.path.dirname(ws)))
        self.assertNotIn("NA-04", [r for r, _ in g.check({"tool": "sql", "target": "postgres://prod-db/app", "query": "SELECT 1"}).findings])
        g2 = Guard(Policy(workspace=ws, env="staging", home=os.path.dirname(ws)))
        self.assertIn("NA-04", [r for r, _ in g2.check({"tool": "sql", "target": "postgres://prod-db/app", "query": "DELETE FROM t WHERE id = 1"}).findings])


if __name__ == "__main__":
    unittest.main()
