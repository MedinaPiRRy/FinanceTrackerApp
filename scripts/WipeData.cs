// Standalone "erase my data" tool for Windows. Built by scripts/build-wipe-tool.ts (the app name is filled in at build time).
// It asks before deleting anything, refuses while the app is running, and never touches files outside the app's data folder.
//   __APP__-Wipe-Data.exe                 asks, then erases the database (backups are kept unless you say so)
//   __APP__-Wipe-Data.exe --yes           no questions: erases the database only
//   __APP__-Wipe-Data.exe --yes --backups also deletes the backup copies
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Windows.Forms;

static class WipeData
{
    const string App = "__APP__";

    [STAThread]
    static int Main(string[] args)
    {
        bool yes = args.Any(a => a.Equals("--yes", StringComparison.OrdinalIgnoreCase));
        bool backups = args.Any(a => a.Equals("--backups", StringComparison.OrdinalIgnoreCase));
        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), App);
        string db = Path.Combine(dir, "finance.db");

        bool onlyBackups = !File.Exists(db) && backups && Directory.Exists(Path.Combine(dir, "backups"));
        if (!File.Exists(db) && !onlyBackups)
        {
            if (!yes) MessageBox.Show("There is no " + App + " data on this computer, so there is nothing to erase.", App, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        if (!yes)
        {
            var ask = MessageBox.Show(
                "This permanently erases ALL of your " + App + " data on this computer (every account, transaction, budget and goal), so you can start again from zero.\n\n" +
                "Folder: " + dir + "\n\n" +
                "Files you imported from, such as Excel workbooks or bank statements, are not touched. This cannot be undone.\n\nErase everything?",
                "Erase " + App + " data", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
            if (ask != DialogResult.Yes) return 1;
        }

        while (Process.GetProcessesByName(App).Length > 0)
        {
            if (yes) return 2;
            var r = MessageBox.Show(App + " is open. Close it, then press Retry.", App, MessageBoxButtons.RetryCancel, MessageBoxIcon.Information);
            if (r == DialogResult.Cancel) return 2;
        }

        if (!yes && Directory.Exists(Path.Combine(dir, "backups")))
        {
            backups = MessageBox.Show("Also delete your backup copies?\n\nChoose No to keep them (recommended unless you want everything gone).", App, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
        }

        int removed = 0;
        foreach (var name in new[] { "finance.db", "finance.db-wal", "finance.db-shm", "sample.db", "sample.db-wal", "sample.db-shm", "app-state.json" })
        {
            string f = Path.Combine(dir, name);
            if (File.Exists(f)) { File.Delete(f); removed++; }
        }
        foreach (var f in Directory.GetFiles(dir, "finance.db.bak-*")) { File.Delete(f); removed++; }
        if (backups && Directory.Exists(Path.Combine(dir, "backups"))) { Directory.Delete(Path.Combine(dir, "backups"), true); removed++; }

        if (!yes) MessageBox.Show("Done. " + App + " will start from zero the next time you open it.", App, MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 0;
    }
}
