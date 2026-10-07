Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('RemoteMcpUiNative' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class RemoteMcpUiNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetUserObjectInformation(
        IntPtr handle, int index, StringBuilder info, int length, out int needed);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr handle, int command);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr handle);
}
'@
}

function ConvertTo-HexHandle {
  param([int]$Handle)
  return ('0x{0:x}' -f ([int64]$Handle -band 0xffffffffL))
}

function ConvertTo-RemoteMcpRect {
  param($Rectangle)
  function ConvertTo-BoundedInt {
    param([double]$Value)
    if ([double]::IsNaN($Value) -or [double]::IsInfinity($Value)) { return 0 }
    if ($Value -gt [int]::MaxValue) { return [int]::MaxValue }
    if ($Value -lt [int]::MinValue) { return [int]::MinValue }
    return [int][Math]::Round($Value)
  }
  return [ordered]@{
    x = ConvertTo-BoundedInt $Rectangle.X
    y = ConvertTo-BoundedInt $Rectangle.Y
    width = ConvertTo-BoundedInt $Rectangle.Width
    height = ConvertTo-BoundedInt $Rectangle.Height
  }
}

function Get-RemoteMcpInputDesktop {
  $desktop = [RemoteMcpUiNative]::OpenInputDesktop(0, $false, 0x0001)
  if ($desktop -eq [IntPtr]::Zero) {
    return [ordered]@{ name = 'Unavailable'; interactive = $false }
  }
  try {
    $needed = 0
    [void][RemoteMcpUiNative]::GetUserObjectInformation($desktop, 2, $null, 0, [ref]$needed)
    $name = [Text.StringBuilder]::new([Math]::Max(64, $needed))
    if (-not [RemoteMcpUiNative]::GetUserObjectInformation($desktop, 2, $name, $name.Capacity, [ref]$needed)) {
      return [ordered]@{ name = 'Unknown'; interactive = $false }
    }
    $value = $name.ToString()
    return [ordered]@{ name = $value; interactive = ($value -eq 'Default') }
  }
  finally {
    [void][RemoteMcpUiNative]::CloseDesktop($desktop)
  }
}

function Get-RemoteMcpControlType {
  param([System.Windows.Automation.AutomationElement]$Element)
  $name = $Element.Current.ControlType.ProgrammaticName
  if ($name -like 'ControlType.*') { return $name.Substring(12) }
  return $name
}

function ConvertTo-RemoteMcpWindow {
  param([System.Windows.Automation.AutomationElement]$Element)
  $handle = $Element.Current.NativeWindowHandle
  $modal = $false
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
    if ($null -ne $pattern) { $modal = $pattern.Current.IsModal }
  } catch { }
  $dpi = 96
  try {
    $reported = [RemoteMcpUiNative]::GetDpiForWindow([IntPtr]::new($handle))
    if ($reported -gt 0) { $dpi = [int]$reported }
  } catch { }
  return [ordered]@{
    handle = ConvertTo-HexHandle $handle
    processId = $Element.Current.ProcessId
    title = $Element.Current.Name
    className = $Element.Current.ClassName
    bounds = ConvertTo-RemoteMcpRect $Element.Current.BoundingRectangle
    dpi = $dpi
    focused = $Element.Current.HasKeyboardFocus
    modal = $modal
  }
}

function ConvertTo-RemoteMcpElement {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$WindowHandle
  )
  $patterns = [Collections.Generic.List[string]]::new()
  foreach ($entry in @(
    @('Invoke', [System.Windows.Automation.InvokePattern]::Pattern),
    @('Value', [System.Windows.Automation.ValuePattern]::Pattern),
    @('SelectionItem', [System.Windows.Automation.SelectionItemPattern]::Pattern),
    @('Toggle', [System.Windows.Automation.TogglePattern]::Pattern),
    @('ExpandCollapse', [System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  )) {
    try { if ($null -ne $Element.GetCurrentPattern($entry[1])) { $patterns.Add([string]$entry[0]) } } catch { }
  }
  $runtimeId = (($Element.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.')
  return [ordered]@{
    runtimeId = $runtimeId
    windowHandle = $WindowHandle
    automationId = $Element.Current.AutomationId
    name = $Element.Current.Name
    controlType = Get-RemoteMcpControlType $Element
    bounds = ConvertTo-RemoteMcpRect $Element.Current.BoundingRectangle
    enabled = $Element.Current.IsEnabled
    focused = $Element.Current.HasKeyboardFocus
    password = $Element.Current.IsPassword
    patterns = @($patterns)
  }
}

function Get-RemoteMcpWindows {
  $children = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $result = [Collections.Generic.List[object]]::new()
  foreach ($element in $children) {
    try {
      if ($element.Current.NativeWindowHandle -ne 0 -and -not $element.Current.IsOffscreen) {
        $result.Add((ConvertTo-RemoteMcpWindow $element))
      }
    } catch [System.Windows.Automation.ElementNotAvailableException] { }
  }
  return @($result)
}

function Find-RemoteMcpWindowElement {
  param($Window)
  $handleText = [string]$Window.handle
  $handle = if ($handleText.StartsWith('0x')) {
    [Convert]::ToInt32($handleText.Substring(2), 16)
  } else { [int]$handleText }
  $element = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($handle))
  if ($null -eq $element) { throw [System.Windows.Automation.ElementNotAvailableException]::new('Window is stale') }
  return $element
}

function Test-RemoteMcpElementMatch {
  param([System.Windows.Automation.AutomationElement]$Element, $Target)
  if ($null -ne $Target.runtimeId -and [string]$Target.runtimeId -ne (($Element.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.')) { return $false }
  if ($null -ne $Target.automationId -and [string]$Target.automationId -ne $Element.Current.AutomationId) { return $false }
  if ($null -ne $Target.name -and [string]$Target.name -ne $Element.Current.Name) { return $false }
  if ($null -ne $Target.controlType -and [string]$Target.controlType -ne (Get-RemoteMcpControlType $Element)) { return $false }
  return $true
}

function Find-RemoteMcpTargetElement {
  param([System.Windows.Automation.AutomationElement]$WindowElement, $Target)
  $all = $WindowElement.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($element in $all) {
    try { if (Test-RemoteMcpElementMatch $element $Target) { return $element } }
    catch [System.Windows.Automation.ElementNotAvailableException] { }
  }
  throw [System.Windows.Automation.ElementNotAvailableException]::new('Element is stale or unavailable')
}

function Get-RemoteMcpForegroundHandle {
  return ('0x{0:x}' -f ([RemoteMcpUiNative]::GetForegroundWindow().ToInt64()))
}

function Set-RemoteMcpForegroundWindow {
  param([System.Windows.Automation.AutomationElement]$Element)
  $handle = [IntPtr]::new($Element.Current.NativeWindowHandle)
  [void][RemoteMcpUiNative]::ShowWindow($handle, 9)
  [void][RemoteMcpUiNative]::SetForegroundWindow($handle)
  $Element.SetFocus()
}

function Invoke-RemoteMcpMouseClick {
  param([int]$X, [int]$Y)
  [void][RemoteMcpUiNative]::SetCursorPos($X, $Y)
  [RemoteMcpUiNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [RemoteMcpUiNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function ConvertTo-RemoteMcpSendKeys {
  param([object[]]$Keys)
  $modifiers = ''
  $ordinary = [Collections.Generic.List[string]]::new()
  foreach ($key in $Keys) {
    switch ([string]$key) {
      'CTRL' { $modifiers += '^' }
      'ALT' { $modifiers += '%' }
      'SHIFT' { $modifiers += '+' }
      'ENTER' { $ordinary.Add('{ENTER}') }
      'TAB' { $ordinary.Add('{TAB}') }
      'ESC' { $ordinary.Add('{ESC}') }
      'DELETE' { $ordinary.Add('{DELETE}') }
      default {
        $value = [string]$key
        if ($value.Length -eq 1) { $ordinary.Add($value.ToLowerInvariant()) }
        else { $ordinary.Add(('{' + $value.ToUpperInvariant() + '}')) }
      }
    }
  }
  return $modifiers + ($ordinary -join '')
}

function Invoke-RemoteMcpUiOperation {
  param($Request)
  $desktop = Get-RemoteMcpInputDesktop
  if ($Request.operation -ne 'desktop_state' -and -not $desktop.interactive) {
    return [ordered]@{ ok = $false; code = 'secure_desktop'; message = 'The interactive Default desktop is unavailable'; secureDesktop = $true; desktop = $desktop }
  }
  switch ([string]$Request.operation) {
    'desktop_state' {
      return [ordered]@{ ok = $true; secureDesktop = (-not $desktop.interactive); desktop = $desktop }
    }
    'windows' {
      return [ordered]@{ ok = $true; windows = @(Get-RemoteMcpWindows) }
    }
    'inspect' {
      $windowElement = Find-RemoteMcpWindowElement $Request.payload.window
      $window = ConvertTo-RemoteMcpWindow $windowElement
      $all = $windowElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $elements = [Collections.Generic.List[object]]::new()
      foreach ($element in $all) {
        try { $elements.Add((ConvertTo-RemoteMcpElement $element $window.handle)) }
        catch [System.Windows.Automation.ElementNotAvailableException] { }
      }
      return [ordered]@{ ok = $true; window = $window; elements = @($elements) }
    }
    'focus' {
      $windowElement = Find-RemoteMcpWindowElement $Request.payload.window
      Set-RemoteMcpForegroundWindow $windowElement
      Start-Sleep -Milliseconds 60
      $handle = ConvertTo-HexHandle $windowElement.Current.NativeWindowHandle
      $foreground = Get-RemoteMcpForegroundHandle
      return [ordered]@{ ok = $true; evidence = [ordered]@{ kind = 'observed_state'; windowHandle = $handle; focusedWindowHandle = $foreground; verified = ($foreground -eq $handle) } }
    }
    { $_ -in @('invoke', 'click', 'type') } {
      $windowElement = Find-RemoteMcpWindowElement $Request.payload.window
      Set-RemoteMcpForegroundWindow $windowElement
      $target = $null
      if ($null -ne $Request.payload.target) { $target = Find-RemoteMcpTargetElement $windowElement $Request.payload.target }
      if ($Request.operation -eq 'invoke') {
        if ($null -eq $target) { throw 'Invoke requires a semantic target' }
        $pattern = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        if ($null -eq $pattern) { throw 'Target does not support InvokePattern' }
        $pattern.Invoke()
      }
      elseif ($Request.operation -eq 'click') {
        if ($null -ne $target) {
          $point = $target.GetClickablePoint()
          Invoke-RemoteMcpMouseClick ([int]$point.X) ([int]$point.Y)
        } else {
          Invoke-RemoteMcpMouseClick ([int]$Request.payload.point.x) ([int]$Request.payload.point.y)
        }
      }
      else {
        if ($null -eq $target) { throw 'Type requires a semantic target' }
        $target.SetFocus()
        $pattern = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($null -eq $pattern) { throw 'Target does not support ValuePattern' }
        $pattern.SetValue([string]$Request.payload.text)
      }
      Start-Sleep -Milliseconds 80
      $handle = ConvertTo-HexHandle $windowElement.Current.NativeWindowHandle
      $foreground = Get-RemoteMcpForegroundHandle
      $runtimeId = if ($null -eq $target) { $null } else { (($target.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.') }
      $value = $null
      if ($Request.operation -eq 'type' -and $null -ne $target) {
        $value = if ($target.Current.IsPassword) { '[REDACTED]' } else { [string]$Request.payload.text }
      }
      return [ordered]@{ ok = $true; evidence = [ordered]@{ kind = 'observed_state'; windowHandle = $handle; focusedWindowHandle = $foreground; runtimeId = $runtimeId; value = $value; verified = ($foreground -eq $handle) } }
    }
    'keys' {
      $windowElement = Find-RemoteMcpWindowElement $Request.payload.window
      Set-RemoteMcpForegroundWindow $windowElement
      [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-RemoteMcpSendKeys @($Request.payload.keys)))
      Start-Sleep -Milliseconds 60
      $handle = ConvertTo-HexHandle $windowElement.Current.NativeWindowHandle
      $foreground = Get-RemoteMcpForegroundHandle
      return [ordered]@{ ok = $true; evidence = [ordered]@{ kind = 'observed_state'; windowHandle = $handle; focusedWindowHandle = $foreground; verified = ($foreground -eq $handle) } }
    }
    'capture' {
      if ($null -ne $Request.payload.window) {
        $windowElement = Find-RemoteMcpWindowElement $Request.payload.window
        $rect = $windowElement.Current.BoundingRectangle
        $bounds = [Drawing.Rectangle]::new([int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height)
        $handle = ConvertTo-HexHandle $windowElement.Current.NativeWindowHandle
      } else {
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $handle = $null
      }
      if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'Capture bounds are empty' }
      $bitmap = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
      try {
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try { $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size, [Drawing.CopyPixelOperation]::SourceCopy) }
        finally { $graphics.Dispose() }
        $bitmap.Save([string]$Request.payload.path, [Drawing.Imaging.ImageFormat]::Png)
      } finally { $bitmap.Dispose() }
      return [ordered]@{ ok = $true; evidence = [ordered]@{ kind = 'screenshot'; path = [string]$Request.payload.path; windowHandle = $handle; verified = $true } }
    }
    default { return [ordered]@{ ok = $false; code = 'unsupported_operation'; message = 'Unsupported GUI operation' } }
  }
}

function Invoke-RemoteMcpUiCommand {
  [CmdletBinding()]
  param()
  try {
    $json = [Console]::In.ReadToEnd()
    $request = $json | ConvertFrom-Json
    $result = Invoke-RemoteMcpUiOperation $request
  }
  catch [System.Windows.Automation.ElementNotAvailableException] {
    $result = [ordered]@{ ok = $false; code = 'stale_element'; message = 'UI element became stale' }
  }
  catch {
    $message = $_.Exception.Message
    if ($message.Length -gt 500) { $message = $message.Substring(0, 500) }
    $result = [ordered]@{ ok = $false; code = 'operation_failed'; message = $message }
  }
  [Console]::Out.Write(($result | ConvertTo-Json -Depth 40 -Compress))
}

Export-ModuleMember -Function Invoke-RemoteMcpUiCommand
