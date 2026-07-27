import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Moon, Sun, Bell, Globe, RefreshCw, Save, User, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export default function Settings() {
  const { user, logout } = useAuth();
  const [settings, setSettings] = useState({
    theme: 'dark',
    currency: 'INR',
    language: 'en',
    refreshInterval: 5,
    notifications: {
      priceAlerts: true,
      marketOpen: true,
      marketClose: true,
      earnings: true,
      news: false,
    },
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Load settings from localStorage
    const savedSettings = localStorage.getItem('appSettings');
    if (savedSettings) {
      setSettings(JSON.parse(savedSettings));
    }
  }, []);

  const handleSave = () => {
    setLoading(true);
    localStorage.setItem('appSettings', JSON.stringify(settings));
    
    // Apply theme
    if (settings.theme === 'light') {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }
    
    setTimeout(() => {
      setLoading(false);
      toast.success("Settings saved", {
        description: "Your preferences have been updated.",
      });
    }, 500);
  };

  const handleLogout = () => {
    logout();
    toast.success("Logged out", {
      description: "You have been logged out successfully.",
    });
  };

  return (
    <div className="space-y-6 animate-fade-up" data-testid="settings-page">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="gs-label">Preferences</div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-1">
            Settings
          </h1>
          <p className="text-sm text-gs-textMuted mt-1">
            Customize your experience, notifications, and display preferences.
          </p>
        </div>
        <Button
          onClick={handleSave}
          disabled={loading}
          className="flex items-center gap-2 bg-gs-gold text-gs-bg font-medium px-4 py-2 rounded-sm hover:bg-gs-gold/90 transition"
        >
          <Save className="w-4 h-4" />
          {loading ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>

      {/* User Profile Section */}
      <div className="gs-card p-5">
        <div className="flex items-center gap-3 mb-4">
          <User className="w-5 h-5 text-gs-gold" />
          <h3 className="font-display font-bold text-gs-text">Profile</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-gs-textMuted mb-1 block">Username</label>
            <Input
              value={user?.username || ''}
              disabled
              className="bg-gs-bg border-gs-border text-gs-textMuted"
            />
          </div>
          <div>
            <label className="text-sm text-gs-textMuted mb-1 block">Email</label>
            <Input
              value={user?.email || ''}
              disabled
              className="bg-gs-bg border-gs-border text-gs-textMuted"
            />
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-gs-border">
          <Button
            onClick={handleLogout}
            variant="outline"
            className="flex items-center gap-2 border-gs-neg/30 text-gs-neg hover:bg-gs-neg/10"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </Button>
        </div>
      </div>

      {/* Appearance */}
      <div className="gs-card p-5">
        <div className="flex items-center gap-3 mb-4">
          <Sun className="w-5 h-5 text-gs-gold" />
          <h3 className="font-display font-bold text-gs-text">Appearance</h3>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gs-text">Theme</div>
              <div className="text-xs text-gs-textMuted mt-0.5">Choose your preferred color scheme</div>
            </div>
            <Select value={settings.theme} onValueChange={(value) => setSettings({...settings, theme: value})}>
              <SelectTrigger className="bg-gs-bg border-gs-border w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-gs-card border-gs-border">
                <SelectItem value="dark">
                  <div className="flex items-center gap-2">
                    <Moon className="w-4 h-4" />
                    Dark
                  </div>
                </SelectItem>
                <SelectItem value="light">
                  <div className="flex items-center gap-2">
                    <Sun className="w-4 h-4" />
                    Light
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gs-text">Currency</div>
              <div className="text-xs text-gs-textMuted mt-0.5">Display currency for prices</div>
            </div>
            <Select value={settings.currency} onValueChange={(value) => setSettings({...settings, currency: value})}>
              <SelectTrigger className="bg-gs-bg border-gs-border w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-gs-card border-gs-border">
                <SelectItem value="INR">₹ INR</SelectItem>
                <SelectItem value="USD">$ USD</SelectItem>
                <SelectItem value="EUR">€ EUR</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gs-text">Language</div>
              <div className="text-xs text-gs-textMuted mt-0.5">Interface language</div>
            </div>
            <Select value={settings.language} onValueChange={(value) => setSettings({...settings, language: value})}>
              <SelectTrigger className="bg-gs-bg border-gs-border w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-gs-card border-gs-border">
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="hi">हिंदी</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Data Refresh */}
      <div className="gs-card p-5">
        <div className="flex items-center gap-3 mb-4">
          <RefreshCw className="w-5 h-5 text-gs-gold" />
          <h3 className="font-display font-bold text-gs-text">Data Refresh</h3>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-gs-text">Refresh Interval</div>
            <div className="text-xs text-gs-textMuted mt-0.5">How often to update stock prices</div>
          </div>
          <Select value={settings.refreshInterval.toString()} onValueChange={(value) => setSettings({...settings, refreshInterval: Number(value)})}>
            <SelectTrigger className="bg-gs-bg border-gs-border w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-gs-card border-gs-border">
              <SelectItem value="1">1 second</SelectItem>
              <SelectItem value="5">5 seconds</SelectItem>
              <SelectItem value="10">10 seconds</SelectItem>
              <SelectItem value="30">30 seconds</SelectItem>
              <SelectItem value="60">1 minute</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Notifications */}
      <div className="gs-card p-5">
        <div className="flex items-center gap-3 mb-4">
          <Bell className="w-5 h-5 text-gs-gold" />
          <h3 className="font-display font-bold text-gs-text">Notifications</h3>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gs-text">Price Alerts</div>
              <div className="text-xs text-gs-textMuted mt-0.5">Notify when stocks hit target prices</div>
            </div>
            <Switch
              checked={settings.notifications.priceAlerts}
              onCheckedChange={(checked) => setSettings({
                ...settings,
                notifications: { ...settings.notifications, priceAlerts: checked }
              })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gs-text">Market Open</div>
              <div className="text-xs text-gs-textMuted mt-0.5">Notify when market opens</div>
            </div>
            <Switch
              checked={settings.notifications.marketOpen}
              onCheckedChange={(checked) => setSettings({
                ...settings,
                notifications: { ...settings.notifications, marketOpen: checked }
              })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gs-text">Market Close</div>
              <div className="text-xs text-gs-textMuted mt-0.5">Notify when market closes</div>
            </div>
            <Switch
              checked={settings.notifications.marketClose}
              onCheckedChange={(checked) => setSettings({
                ...settings,
                notifications: { ...settings.notifications, marketClose: checked }
              })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gs-text">Earnings Alerts</div>
              <div className="text-xs text-gs-textMuted mt-0.5">Notify about earnings announcements</div>
            </div>
            <Switch
              checked={settings.notifications.earnings}
              onCheckedChange={(checked) => setSettings({
                ...settings,
                notifications: { ...settings.notifications, earnings: checked }
              })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gs-text">News Updates</div>
              <div className="text-xs text-gs-textMuted mt-0.5">Notify about market news</div>
            </div>
            <Switch
              checked={settings.notifications.news}
              onCheckedChange={(checked) => setSettings({
                ...settings,
                notifications: { ...settings.notifications, news: checked }
              })}
            />
          </div>
        </div>
      </div>

      {/* About */}
      <div className="gs-card p-5">
        <div className="flex items-center gap-3 mb-4">
          <Globe className="w-5 h-5 text-gs-gold" />
          <h3 className="font-display font-bold text-gs-text">About</h3>
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gs-textMuted">Version</span>
            <span className="text-gs-text font-mono">1.0.0</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gs-textMuted">Build</span>
            <span className="text-gs-text font-mono">2026.07.28</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gs-textMuted">Environment</span>
            <span className="text-gs-text font-mono">Production</span>
          </div>
        </div>
      </div>
    </div>
  );
}
