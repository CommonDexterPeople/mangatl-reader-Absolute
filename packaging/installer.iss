; Inno Setup script for the packaged Windows build.
;
; BUILD ORDER
;   python build.py
;   pyinstaller packaging/MangaTL-Reader.spec --noconfirm ^
;       --distpath packaging/out --workpath packaging/work
;   iscc packaging/installer.iss
;
; Produces packaging/Output/MangaTL-Reader-Setup.exe — one file to hand to
; someone, which installs a normal Windows app with a Start Menu shortcut.
;
; WHY AN INSTALLER RATHER THAN A BARE .EXE
;   PyInstaller onedir output is a folder where the .exe only works next to
;   its _internal/ directory. Handing that to a non-technical user invites
;   "I moved the exe to my desktop and it broke". An installer keeps the
;   layout intact, adds a Start Menu entry, and gives a normal uninstall.
;   It is also markedly less likely to be quarantined than a onefile exe.

#define AppName        "MangaTL Reader"
#define AppVersion     "1.0.0"
#define AppPublisher   "CommonDexterPeople"
#define AppURL         "https://github.com/CommonDexterPeople/mangatl-reader-Absolute"
#define AppExeName     "MangaTL-Reader.exe"

[Setup]
AppId={{7B3C1E42-9A6D-4F58-8C21-2E9D4A6F1B03}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
DefaultDirName={autopf}\MangaTL-Reader
DefaultGroupName={#AppName}
OutputDir=Output
OutputBaseFilename=MangaTL-Reader-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Per-user install by default: no UAC prompt (one less scary dialog for a
; non-technical user), and the install directory stays writable, which
; matters because the app caches downloaded model files next to itself.
; Set to "admin" only if you want a single machine-wide install — then also
; set MTL_MODEL_DIR, since Program Files is not user-writable.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile=..\LICENSE
; Uninstall must not leave a few hundred MB of bundle behind.
UninstallDisplayIcon={app}\{#AppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
; The whole PyInstaller onedir tree. recursesubdirs pulls in _internal/,
; which is not optional — the exe will not start without it.
Source: "out\MangaTL-Reader\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}";              Filename: "{app}\{#AppExeName}"
Name: "{group}\Uninstall {#AppName}";    Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}";        Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
; The app prints its URL to a console window and opens the browser itself.
Filename: "{app}\{#AppExeName}"; Description: "Start {#AppName} now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Model cache created at runtime next to the exe (see _MODEL_CACHE_DIR).
; Not part of [Files], so Inno would otherwise leave the folder behind.
Type: filesandordirs; Name: "{app}\models"
