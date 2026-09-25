const path = require("node:path");

const fs = require("node:fs/promises");

const { sign } = require("@electron/windows-sign");

const certificateFile = process.env.WINDOWS_CERTIFICATE_FILE;

const certificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;

const windowsSign = certificateFile && certificatePassword
  ? { certificateFile, certificatePassword, hashes: ["sha256"] }
  : undefined;

if (process.env.RELEASE_BUILD === "1" && !windowsSign) {
  throw new Error("A release build requires Windows signing credentials.");
}

async function appFilesToSign(directory) {
  const files = [];

  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === "playwright-browsers") continue;
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) files.push(...await appFilesToSign(fullPath));
    else if (/\.(exe|dll|node|ps1)$/i.test(entry.name)) files.push(fullPath);
  }

  return files;
}

module.exports = {
  hooks: {
    postPackage: async ({ platform, outputPaths }) => {
      if (platform !== "win32" || !windowsSign) return;

      for (const outputPath of outputPaths) {
        const files = await appFilesToSign(outputPath);

        if (!files.some((file) => path.basename(file).toLowerCase() === "permitmonitor.exe")) {
          throw new Error("Packaged application executable is missing.");
        }

        await sign({ ...windowsSign, files });
      }
    },
  },
  packagerConfig: {
    asar: true,
    executableName: "PermitMonitor",
    icon: path.resolve(__dirname, "assets/icon"),
    extraResource: [
      path.resolve(__dirname, "vendor/playwright-browsers"),
      path.resolve(__dirname, "dist/authenticode.ps1"),
    ],
    win32metadata: {
      CompanyName: "Permit Monitor",
      FileDescription: "Permit Monitor",
      ProductName: "Permit Monitor",
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "PermitMonitor",
        authors: "Permit Monitor",
        setupExe: "PermitMonitorSetup.exe",
        setupIcon: path.resolve(__dirname, "assets/icon.ico"),
        ...(windowsSign ? { windowsSign } : {}),
      },
    },
  ],
};
