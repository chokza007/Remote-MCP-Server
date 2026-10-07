Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$xaml = @'
<Window
  xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  Title="Remote MCP GUI Fixture"
  Width="900"
  Height="600"
  Left="320"
  Top="180"
  WindowStartupLocation="Manual">
  <Grid Margin="30">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto" />
      <RowDefinition Height="Auto" />
      <RowDefinition Height="Auto" />
    </Grid.RowDefinitions>
    <StackPanel Grid.Row="0" Orientation="Horizontal">
      <Button x:Name="PrimarySave" AutomationProperties.AutomationId="primary-save" Content="Save" Width="100" Height="32" Margin="0,0,30,0" />
      <Button x:Name="SecondarySave" AutomationProperties.AutomationId="secondary-save" Content="Save" Width="100" Height="32" />
    </StackPanel>
    <PasswordBox x:Name="SecretInput" AutomationProperties.AutomationId="secret-input" Grid.Row="1" Width="300" Height="32" Margin="0,20,0,0" HorizontalAlignment="Left" />
    <TextBlock x:Name="StatusLabel" AutomationProperties.AutomationId="status-label" Grid.Row="2" Text="Ready" Margin="0,20,0,0" />
  </Grid>
</Window>
'@

$reader = [System.Xml.XmlNodeReader]::new([xml]$xaml)
$window = [System.Windows.Markup.XamlReader]::Load($reader)
$primary = $window.FindName('PrimarySave')
$secondary = $window.FindName('SecondarySave')
$status = $window.FindName('StatusLabel')
$primary.Add_Click({ $status.Text = 'Primary saved' })
$secondary.Add_Click({ $status.Text = 'Secondary saved' })

[void]$window.ShowDialog()
