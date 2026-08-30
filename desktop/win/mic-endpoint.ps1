<#
  The Windows mute flag and input volume of the microphones, read (or cleared) for the desktop app.

  Why this exists: a microphone muted in Windows -- the F-row key with the LED, or the switch in
  Settings > System > Sound > Input -- still opens without error, and every sample it delivers is
  zero. Chromium does see that mute (the track reports muted:true, polled once a second), so the
  page can name it; this script is the second line of defence: a definitive read straight from
  Core Audio, the volume as well, every active microphone rather than just the one that was
  opened, and a one-click unmute that the page has no API for.

  Usage:
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File mic-endpoint.ps1 -Command get
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File mic-endpoint.ps1 -Command unmute

  Output, always exactly one line of ASCII JSON on stdout:
    {"name":"<default endpoint>","muted":true|false,"volume":<0-100>,
     "endpoints":[{"name":"<endpoint>","muted":true|false,"volume":<0-100>,"isDefault":true|false},...]}
  or, with exit code 1:
    {"error":"<message>"}

  The top-level name/muted/volume describe the default capture device for the console role --
  the one Chromium opens for "default". "endpoints" lists every active capture endpoint
  (EnumAudioEndpoints eCapture / DEVICE_STATE_ACTIVE), at most 32, with exactly one entry
  marked isDefault (the one whose id matches the console default). "unmute" clears the flag on
  the default endpoint only. Core Audio COM (IMMDeviceEnumerator / IAudioEndpointVolume), no
  administrator rights, PowerShell 5.1. The only input is the fixed -Command word; nothing else
  is ever interpolated.
#>
param([string]$Command = '')

$ErrorActionPreference = 'Stop'

function ConvertTo-JsonString([string]$Text) {
  # Every non-printable or non-ASCII character is \u-escaped, so the line is the same bytes
  # whatever code page the console happens to use -- endpoint names carry (R) signs and Arabic.
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $Text.ToCharArray()) {
    $code = [int]$ch
    if ($ch -eq '"') { [void]$sb.Append('\"') }
    elseif ($ch -eq '\') { [void]$sb.Append('\\') }
    elseif ($code -lt 0x20 -or $code -gt 0x7e) { [void]$sb.Append('\u' + $code.ToString('x4')) }
    else { [void]$sb.Append($ch) }
  }
  return $sb.ToString()
}

function Write-Failure([string]$Message) {
  Write-Output ('{"error":"' + (ConvertTo-JsonString $Message) + '"}')
  exit 1
}

if ($Command -ne 'get' -and $Command -ne 'unmute') {
  Write-Failure 'usage: -Command get | unmute'
}

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace MicEndpoint {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumeratorCom { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceCollection {
    int GetCount(out int count);
    int Item(int index, out IMMDevice device);
  }

  // Vtable order: Activate, OpenPropertyStore, GetId, GetState.
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int stgmAccess, out IPropertyStore store);
    // An out LPWStr is freed by the marshaller with CoTaskMemFree, which is what GetId requires.
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyKey {
    public Guid fmtid;
    public int pid;
    public PropertyKey(Guid fmtid, int pid) { this.fmtid = fmtid; this.pid = pid; }
  }

  // PROPVARIANT: 16 bytes on x86, 24 on x64. Two IntPtr fields cover the union either way.
  [StructLayout(LayoutKind.Sequential)]
  public struct PropVariant {
    public ushort vt;
    public ushort reserved1;
    public ushort reserved2;
    public ushort reserved3;
    public IntPtr p;
    public IntPtr p2;
  }

  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int index, out PropertyKey key);
    int GetValue(ref PropertyKey key, out PropVariant value);
    int SetValue(ref PropertyKey key, ref PropVariant value);
    int Commit();
  }

  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out int count);
    int SetMasterVolumeLevel(float level, ref Guid context);
    int SetMasterVolumeLevelScalar(float level, ref Guid context);
    int GetMasterVolumeLevel(out float level);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(int channel, float level, ref Guid context);
    int SetChannelVolumeLevelScalar(int channel, float level, ref Guid context);
    int GetChannelVolumeLevel(int channel, out float level);
    int GetChannelVolumeLevelScalar(int channel, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  public class Info {
    public string Name;
    public bool Muted;
    public int Volume;
    public bool IsDefault;
  }

  public class Result {
    public Info Default;
    public Info[] Endpoints;
  }

  public static class Endpoint {
    const int E_NOTFOUND = unchecked((int)0x80070490);
    const int eCapture = 1;
    const int eConsole = 0;
    const int DEVICE_STATE_ACTIVE = 1;
    const int CLSCTX_ALL = 23;
    const int STGM_READ = 0;
    const ushort VT_LPWSTR = 31;
    const int MaxEndpoints = 32;

    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PropVariant value);

    static void Check(int hr, string what) {
      if (hr != 0) throw new COMException(what + " failed", hr);
    }

    /** The default console capture endpoint (unmuted first when asked), plus every active one. */
    public static Result Read(bool unmute) {
      IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(object)new MMDeviceEnumeratorCom();
      IMMDevice device;
      int hr = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole, out device);
      if (hr == E_NOTFOUND || device == null) throw new InvalidOperationException("no default capture device");
      Check(hr, "GetDefaultAudioEndpoint");

      IAudioEndpointVolume volume = Volume(device);
      if (unmute) {
        Guid context = Guid.Empty;
        Check(volume.SetMute(false, ref context), "SetMute");
      }
      Info def = Describe(device, volume, true);
      string defaultId = Id(device);

      // Best effort: a device that refuses to activate is skipped, never fatal. The default is
      // always present exactly once -- matched by id, or inserted if the enumeration missed it.
      List<Info> list = new List<Info>();
      bool found = false;
      IMMDeviceCollection all;
      int count;
      if (enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, out all) == 0 && all != null && all.GetCount(out count) == 0) {
        for (int i = 0; i < count; i++) {
          IMMDevice item;
          if (all.Item(i, out item) != 0 || item == null) continue;
          try {
            if (!found && Id(item) == defaultId) {
              list.Add(def);
              found = true;
            } else {
              list.Add(Describe(item, Volume(item), false));
            }
          } catch (Exception) {
            continue;
          }
        }
      }
      if (!found) list.Insert(0, def);
      if (list.Count > MaxEndpoints) {
        List<Info> kept = new List<Info>();
        kept.Add(def);
        foreach (Info info in list) {
          if (!info.IsDefault && kept.Count < MaxEndpoints) kept.Add(info);
        }
        list = kept;
      }

      Result result = new Result();
      result.Default = def;
      result.Endpoints = list.ToArray();
      return result;
    }

    static IAudioEndpointVolume Volume(IMMDevice device) {
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object activated;
      Check(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out activated), "IAudioEndpointVolume activation");
      return (IAudioEndpointVolume)activated;
    }

    static Info Describe(IMMDevice device, IAudioEndpointVolume volume, bool isDefault) {
      bool muted;
      float scalar;
      Check(volume.GetMute(out muted), "GetMute");
      Check(volume.GetMasterVolumeLevelScalar(out scalar), "GetMasterVolumeLevelScalar");
      int percent = (int)Math.Round(scalar * 100);
      if (percent < 0) percent = 0;
      if (percent > 100) percent = 100;

      Info info = new Info();
      info.Name = FriendlyName(device);
      info.Muted = muted;
      info.Volume = percent;
      info.IsDefault = isDefault;
      return info;
    }

    static string Id(IMMDevice device) {
      string id;
      if (device.GetId(out id) != 0 || id == null) return "";
      return id;
    }

    static string FriendlyName(IMMDevice device) {
      IPropertyStore store;
      if (device.OpenPropertyStore(STGM_READ, out store) != 0 || store == null) return "";
      // PKEY_Device_FriendlyName
      PropertyKey key = new PropertyKey(new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 14);
      PropVariant value;
      if (store.GetValue(ref key, out value) != 0) return "";
      try {
        if (value.vt != VT_LPWSTR || value.p == IntPtr.Zero) return "";
        return Marshal.PtrToStringUni(value.p) ?? "";
      } finally {
        PropVariantClear(ref value);
      }
    }
  }
}
'@

$result = $null
$failure = $null
try {
  Add-Type -TypeDefinition $source -Language CSharp
  $result = [MicEndpoint.Endpoint]::Read($Command -eq 'unmute')
} catch {
  # A .NET exception reaches PowerShell wrapped in a MethodInvocationException; the inner one
  # carries the message worth logging.
  $failure = $_.Exception
  if ($failure.InnerException) { $failure = $failure.InnerException }
}
if ($failure) { Write-Failure $failure.Message }

function ConvertTo-Bool($Value) {
  if ($Value) { return 'true' } else { return 'false' }
}

function Format-Endpoint($Info) {
  return ('{"name":"' + (ConvertTo-JsonString ([string]$Info.Name)) + '","muted":' + (ConvertTo-Bool $Info.Muted) +
    ',"volume":' + [int]$Info.Volume + ',"isDefault":' + (ConvertTo-Bool $Info.IsDefault) + '}')
}

$parts = New-Object System.Collections.Generic.List[string]
foreach ($info in $result.Endpoints) { $parts.Add((Format-Endpoint $info)) }
$default = $result.Default
Write-Output ('{"name":"' + (ConvertTo-JsonString ([string]$default.Name)) + '","muted":' + (ConvertTo-Bool $default.Muted) +
  ',"volume":' + [int]$default.Volume + ',"endpoints":[' + ($parts -join ',') + ']}')
exit 0
