import { expect, test } from "bun:test";
import { execa } from "execa";

test("release smoke describes macOS without reading Linux os-release files", async () => {
  const result = await execa("python3", ["-c", `
import runpy
from unittest.mock import patch
module = runpy.run_path('scripts/smoke-release.py')
with patch('platform.system', return_value='Darwin'), patch('platform.mac_ver', return_value=('15.0', (), 'arm64')), patch('platform.freedesktop_os_release', side_effect=AssertionError('Linux-only API')):
    print(module['platform_description']())
`]);
  expect(result.stdout).toBe("macOS 15.0");
});

test("release smoke handles Linux without os-release metadata", async () => {
  const result = await execa("python3", ["-c", `
import runpy
from unittest.mock import patch
module = runpy.run_path('scripts/smoke-release.py')
with patch('platform.system', return_value='Linux'), patch('platform.freedesktop_os_release', side_effect=OSError('missing')):
    print(module['platform_description']())
`]);
  expect(result.stdout).toBe("Linux");
});
