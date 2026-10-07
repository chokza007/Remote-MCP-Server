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
  WindowStartupLocation="Manual"
  WindowStyle="None"
  ResizeMode="CanResize"
  Background="#090D14"
  Foreground="#EAF2FA"
  BorderBrush="#2B3B52"
  BorderThickness="1"
  FontFamily="Segoe UI">
  <Window.Resources>
    <Style TargetType="{x:Type Button}">
      <Setter Property="Background" Value="#223148" />
      <Setter Property="Foreground" Value="#EAF2FA" />
      <Setter Property="BorderBrush" Value="#3B506D" />
      <Setter Property="BorderThickness" Value="1" />
      <Setter Property="Cursor" Value="Hand" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="{x:Type Button}">
            <Border x:Name="ButtonBorder" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="5">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" />
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="ButtonBorder" Property="Background" Value="#315078" /></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="ButtonBorder" Property="Background" Value="#4F8CFF" /></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Grid Background="#090D14">
    <Grid.RowDefinitions>
      <RowDefinition Height="42" />
      <RowDefinition Height="*" />
    </Grid.RowDefinitions>
    <Border x:Name="TitleBar" Grid.Row="0" Background="#111823" BorderBrush="#2B3B52" BorderThickness="0,0,0,1">
      <Grid>
        <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="48" /></Grid.ColumnDefinitions>
        <TextBlock Text="Remote MCP GUI Fixture" Margin="14,0,0,0" VerticalAlignment="Center" FontWeight="SemiBold" Foreground="#EAF2FA" />
        <Button x:Name="CloseButton" AutomationProperties.AutomationId="window-close" Grid.Column="1" Content="&#x2715;" Width="34" Height="28" Margin="0,0,7,0" HorizontalAlignment="Right" Background="#2B3B52" />
      </Grid>
    </Border>
    <Grid Grid.Row="1" Margin="30" Background="#090D14">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto" />
        <RowDefinition Height="Auto" />
        <RowDefinition Height="Auto" />
      </Grid.RowDefinitions>
      <StackPanel Grid.Row="0" Orientation="Horizontal">
        <Button x:Name="PrimarySave" AutomationProperties.AutomationId="primary-save" Content="Save" Width="100" Height="32" Margin="0,0,30,0" />
        <Button x:Name="SecondarySave" AutomationProperties.AutomationId="secondary-save" Content="Save" Width="100" Height="32" />
      </StackPanel>
      <PasswordBox x:Name="SecretInput" AutomationProperties.AutomationId="secret-input" Grid.Row="1" Width="300" Height="32" Margin="0,20,0,0" HorizontalAlignment="Left" Background="#111823" Foreground="#EAF2FA" BorderBrush="#3B506D" CaretBrush="#88B7FF" />
      <TextBlock x:Name="StatusLabel" AutomationProperties.AutomationId="status-label" Grid.Row="2" Text="Ready" Margin="0,20,0,0" Foreground="#AEBED2" />
    </Grid>
  </Grid>
</Window>
'@

$reader = [System.Xml.XmlNodeReader]::new([xml]$xaml)
$window = [System.Windows.Markup.XamlReader]::Load($reader)
$primary = $window.FindName('PrimarySave')
$secondary = $window.FindName('SecondarySave')
$status = $window.FindName('StatusLabel')
$titleBar = $window.FindName('TitleBar')
$close = $window.FindName('CloseButton')
$primary.Add_Click({ $status.Text = 'Primary saved' })
$secondary.Add_Click({ $status.Text = 'Secondary saved' })
$titleBar.Add_MouseLeftButtonDown({ $window.DragMove() })
$close.Add_Click({ $window.Close() })

[void]$window.ShowDialog()
