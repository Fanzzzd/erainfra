#!/usr/bin/env python3
"""Host-independent contract tests; the actual image build runs on Linux."""
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("recipe", HERE / "recipe.py")
recipe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recipe)


class RecipeTest(unittest.TestCase):
    def test_packer_order_is_exact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            template = root / "images/ubuntu/templates/build.ubuntu-24_04.pkr.hcl"
            template.parent.mkdir(parents=True)
            template.write_text('scripts = ["${path.root}/../scripts/build/a.sh", "${path.root}/../scripts/build/B.ps1"]')
            plan = root / "scripts.txt"
            plan.write_text("a.sh\nB.ps1\n")
            recipe.verify(root, plan)
            plan.write_text("B.ps1\na.sh\n")
            with self.assertRaises(ValueError):
                recipe.verify(root, plan)
            plan.write_text("a.sh\n")
            with self.assertRaises(ValueError):
                recipe.verify(root, plan)

    def test_environment_preserves_tool_values_not_runtime_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "environment"
            output = pathlib.Path(directory) / "environment.json"
            source.write_text('PATH="/home/runner/.cargo/bin:/usr/bin"\nJAVA_HOME_21_X64=/usr/lib/jvm/java21\nHOME=/wrong\nLANG=en_US.UTF-8\nACTIONS_RUNNER_ACTION_ARCHIVE_CACHE=/upstream\n')
            recipe.environment(source, output)
            self.assertEqual(json.loads(output.read_text()), {"PATH": "/home/runner/.cargo/bin:/usr/bin", "JAVA_HOME_21_X64": "/usr/lib/jvm/java21"})
            for invalid in ("PATH=$HOME/bin\n", "PATH=`id`\n", "PATH=/a\nPATH=/b\n", "not an assignment\n"):
                source.write_text(invalid)
                with self.assertRaises(ValueError):
                    recipe.environment(source, output)

    def test_overlay_reuses_existing_hashes_and_no_tool_subset(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "overlay.sh"
            dockerfile = HERE.parent / "ubuntu-24.04-js/Dockerfile"
            recipe.overlay(dockerfile, output)
            shell = output.read_text()
            self.assertIn("runner_arch=x64", shell)
            self.assertIn("sha256sum --check --strict", shell)
            self.assertIn("/opt/action-cache/actions_checkout", shell)
            self.assertIn("libnss3", shell)
            self.assertNotIn("node_dir=", shell)
            self.assertNotIn("rustup-init", shell)
            changed = pathlib.Path(directory) / "Dockerfile"
            changed.write_text(dockerfile.read_text().replace("runner_arch=x64", "runner_arch=changed"))
            with self.assertRaises(ValueError):
                recipe.overlay(changed, output)

    def test_layers_are_disjoint_and_keep_hard_links_together(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "a/b").mkdir(parents=True)
            (root / "c").mkdir()
            for name, size in (("a/b/one", 300), ("a/b/two", 300), ("a/three", 300), ("c/four", 300)):
                (root / name).write_bytes(b"x" * size)
            os.link(root / "a/b/one", root / "c/one-link")
            (root / "c/to-a").symlink_to("../a")
            directories, groups = recipe.plan_layers(root, target=500)
            self.assertEqual(sorted(directories), [".", "./a", "./a/b", "./c"])
            for index, path in enumerate(directories[1:], 1):
                self.assertIn(path.rsplit("/", 1)[0], directories[:index], "parent before child")
            files = [path for group in groups for path in group]
            self.assertEqual(sorted(files), sorted(["./a/b/one", "./a/b/two", "./a/three", "./c/four", "./c/one-link", "./c/to-a"]))
            self.assertEqual(len(files), len(set(files)))
            self.assertGreater(len(groups), 1)
            together = [group for group in groups if "./a/b/one" in group][0]
            self.assertIn("./c/one-link", together)
            self.assertLess(together.index("./a/b/one"), together.index("./c/one-link"))


if __name__ == "__main__":
    unittest.main()
