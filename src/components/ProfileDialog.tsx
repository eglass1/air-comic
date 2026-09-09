import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Box,
  Tabs,
  Tab,
  Divider,
  Alert,
  Snackbar,
  Grid,
  Chip,
  Card,
  CardActionArea,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import SaveIcon from '@mui/icons-material/Save';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import FaceRetouchingNaturalIcon from '@mui/icons-material/FaceRetouchingNatural';
import { useChat } from '../context/ChatContext';
import { getParticipantId } from '../services/crypto';
import { AvatarManager } from '../comic/avatarManager';
import { AvatarData, BackdropData, EM_NEUTRAL } from '../comic/types';

interface ProfileDialogProps {
  open: boolean;
  onClose: () => void;
}

const AvatarCardItem: React.FC<{
  name: string;
  filename: string;
  isSelected: boolean;
  onSelect: () => void;
  avatarManager: AvatarManager;
}> = ({ name, filename, isSelected, onSelect, avatarManager }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [avatarData, setAvatarData] = useState<AvatarData | null>(null);

  useEffect(() => {
    let isMounted = true;
    avatarManager.loadAvatar(name).then((data) => {
      if (isMounted && data) {
        setAvatarData(data);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [name, avatarManager]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !avatarData) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const iconCanvas = avatarManager.renderAvatarIcon(avatarData);

    const scale = Math.min(canvas.width / iconCanvas.width, canvas.height / iconCanvas.height);
    const dw = iconCanvas.width * scale;
    const dh = iconCanvas.height * scale;
    const dx = (canvas.width - dw) / 2;
    const dy = (canvas.height - dh) / 2;

    ctx.drawImage(iconCanvas, dx, dy, dw, dh);
  }, [avatarData, avatarManager]);

  return (
    <Card
      elevation={isSelected ? 4 : 1}
      sx={{
        border: '2px solid',
        borderColor: isSelected ? 'primary.main' : 'divider',
        bgcolor: isSelected ? 'rgba(0, 229, 255, 0.08)' : 'background.paper',
        borderRadius: 2,
        transition: 'all 0.15s ease',
        '&:hover': {
          borderColor: 'primary.main',
          transform: 'scale(1.03)',
        },
      }}
    >
      <CardActionArea onClick={onSelect} sx={{ p: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Box
          sx={{
            width: 60,
            height: 60,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: '#ffffff',
            borderRadius: 1.5,
            border: '1px solid #ddd',
            overflow: 'hidden',
          }}
        >
          <canvas ref={canvasRef} width={60} height={60} />
        </Box>
        <Typography
          variant="caption"
          sx={{
            mt: 0.8,
            fontWeight: isSelected ? 800 : 600,
            color: isSelected ? 'primary.main' : 'text.primary',
            textAlign: 'center',
          }}
        >
          {name}
        </Typography>
      </CardActionArea>
    </Card>
  );
};

const SelectedAvatarPreview: React.FC<{
  name: string;
  avatarManager: AvatarManager;
}> = ({ name, avatarManager }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [avatarData, setAvatarData] = useState<AvatarData | null>(null);

  useEffect(() => {
    let isMounted = true;
    avatarManager.loadAvatar(name).then((data) => {
      if (isMounted && data) {
        setAvatarData(data);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [name, avatarManager]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !avatarData) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const rendered = avatarManager.renderCharacter(
      avatarData,
      EM_NEUTRAL,
      0.0,
      false
    );

    const scale = Math.min(
      (canvas.width - 8) / rendered.canvas.width,
      (canvas.height - 8) / rendered.canvas.height
    );
    const dw = rendered.canvas.width * scale;
    const dh = rendered.canvas.height * scale;
    const dx = (canvas.width - dw) / 2;
    const dy = (canvas.height - dh) / 2;

    ctx.drawImage(rendered.canvas, dx, dy, dw, dh);
  }, [avatarData, avatarManager]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <Box
        sx={{
          width: 108,
          height: 108,
          border: '2px solid',
          borderColor: 'primary.main',
          borderRadius: 2,
          bgcolor: '#ffffff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        }}
      >
        <canvas ref={canvasRef} width={108} height={108} />
      </Box>
      <Typography
        variant="subtitle2"
        sx={{ fontWeight: 800, color: 'primary.main', mt: 0.5, textAlign: 'center', fontSize: '0.9rem' }}
      >
        {name}
      </Typography>
    </Box>
  );
};

const SelectedBackdropPreview: React.FC<{
  filename: string;
  avatarManager: AvatarManager;
}> = ({ filename, avatarManager }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [backdropData, setBackdropData] = useState<BackdropData | null>(null);

  const displayName = useMemo(() => {
    return (
      AvatarManager.AVAILABLE_BACKDROPS.find(
        (b) => b.filename.toLowerCase() === filename.toLowerCase()
      )?.name || filename
    );
  }, [filename]);

  useEffect(() => {
    let isMounted = true;
    avatarManager.loadBackdrop(filename).then((data) => {
      if (isMounted && data) {
        setBackdropData(data);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [filename, avatarManager]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !backdropData || !backdropData.canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const bgCanvas = backdropData.canvas;
    const scale = Math.max(canvas.width / bgCanvas.width, canvas.height / bgCanvas.height);
    const dw = bgCanvas.width * scale;
    const dh = bgCanvas.height * scale;
    const dx = (canvas.width - dw) / 2;
    const dy = (canvas.height - dh) / 2;

    ctx.drawImage(bgCanvas, dx, dy, dw, dh);
  }, [backdropData]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <Box
        sx={{
          width: 108,
          height: 108,
          borderRadius: 2,
          bgcolor: '#000000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        }}
      >
        <canvas ref={canvasRef} width={108} height={108} />
      </Box>
      <Typography
        variant="subtitle2"
        sx={{ fontWeight: 800, color: 'primary.main', mt: 0.5, textAlign: 'center', fontSize: '0.9rem' }}
      >
        {displayName}
      </Typography>
    </Box>
  );
};

export const ProfileDialog: React.FC<ProfileDialogProps> = ({ open, onClose }) => {
  const {
    profile,
    updateProfile,
    exportProfileAsJson,
    importProfileFromJson,
  } = useChat();

  const avatarManager = useMemo(() => AvatarManager.getInstance(), []);

  const [tabIndex, setTabIndex] = useState<number>(0);
  const [selectedAvatar, setSelectedAvatar] = useState<string>('Armando');
  const [selectedBackdrop, setSelectedBackdrop] = useState<string>('room.bgb');
  const [screenName, setScreenName] = useState<string>('');
  const [info, setInfo] = useState<string>('');
  const [importedProfile, setImportedProfile] = useState<{
    screenName: string;
    participantId: string;
    info?: string;
    favoriteRoomsCount?: number;
    currentRoomsCount?: number;
    friendsCount?: number;
    created: string;
    rawJson: string;
  } | null>(null);
  const [snack, setSnack] = useState<{ message: string; severity: 'success' | 'error' } | null>(null);

  useEffect(() => {
    if (!open) {
      setImportedProfile(null);
    }
  }, [open]);

  useEffect(() => {
    if (profile) {
      setSelectedAvatar(profile.avatarName || 'Armando');
      setSelectedBackdrop(profile.backdropName || 'room.bgb');
      setScreenName(profile.screenName || 'AirComic User');
      setInfo(profile.contactInfo?.info || profile.contactInfo?.name || '');
    }
  }, [profile, open]);

  const handleSaveProfile = async () => {
    if (!screenName.trim()) {
      setSnack({ message: 'Screen name cannot be empty', severity: 'error' });
      return;
    }

    await updateProfile({
      screenName: screenName.trim(),
      avatarName: selectedAvatar,
      backdropName: selectedBackdrop,
      contactInfo: {
        info: info.trim(),
      },
    });

    setSnack({ message: 'Profile & Avatar updated successfully!', severity: 'success' });
  };

  const handleExportJson = async () => {
    if (screenName.trim()) {
      await updateProfile({
        screenName: screenName.trim(),
        avatarName: selectedAvatar,
        backdropName: selectedBackdrop,
        contactInfo: {
          info: info.trim(),
        },
      });
    }
    const jsonStr = await exportProfileAsJson();
    if (!jsonStr) {
      setSnack({ message: 'Failed to export profile data', severity: 'error' });
      return;
    }
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aircomic-backup-${screenName.toLowerCase().replace(/\s+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setSnack({ message: 'Profile, rooms, and friends exported successfully!', severity: 'success' });
  };

  const handleImportJson = async () => {
    if (!importedProfile) {
      setSnack({ message: 'No profile loaded for import', severity: 'error' });
      return;
    }
    const success = await importProfileFromJson(importedProfile.rawJson);
    if (success) {
      setSnack({ message: 'Profile, rooms, and friends restored! Messages cleared.', severity: 'success' });
      setImportedProfile(null);
    } else {
      setSnack({ message: 'Invalid profile backup JSON format or corrupted keys', severity: 'error' });
    }
  };

  const handleClearImport = () => {
    setImportedProfile(null);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const content = event.target?.result as string;
        if (content) {
          try {
            const parsed = JSON.parse(content);
            if (!parsed || typeof parsed !== 'object') {
              throw new Error('Invalid JSON file format');
            }
            const profileData =
              parsed.profile && typeof parsed.profile === 'object' ? parsed.profile : parsed;
            if (
              !profileData.signingPublicKeyBase64 &&
              !profileData.participantId &&
              !parsed.participantId
            ) {
              throw new Error('Invalid backup: missing identity keys');
            }
            let pid = parsed.participantId || profileData.participantId || '';
            if (!pid && profileData.signingPublicKeyBase64) {
              try {
                pid = await getParticipantId(profileData.signingPublicKeyBase64);
              } catch {
                pid = 'Unknown';
              }
            }
            let createdStr = 'Unknown';
            const timestamp = parsed.exportedAt || profileData.createdAt || parsed.createdAt;
            if (timestamp) {
              const d = new Date(timestamp);
              createdStr = isNaN(d.getTime()) ? String(timestamp) : d.toLocaleString();
            }
            const scrName = parsed.screenName || profileData.screenName || 'Unknown';
            const bioInfo =
              parsed.info ?? parsed.contactInfo?.info ?? profileData.contactInfo?.info ?? '';
            const favCount = (parsed.favoriteRooms || parsed.favorites || []).length;
            const roomsCount = (parsed.currentRooms || parsed.rooms || parsed.tabs || []).length;
            const friendsCount = (parsed.friends || []).length;

            setImportedProfile({
              screenName: scrName,
              participantId: pid || 'Unknown',
              info: bioInfo,
              favoriteRoomsCount: favCount,
              currentRoomsCount: roomsCount,
              friendsCount,
              created: createdStr,
              rawJson: content,
            });
            setSnack({ message: 'Backup file loaded and ready to restore.', severity: 'success' });
          } catch (err: any) {
            setSnack({ message: err?.message || 'Invalid backup JSON file', severity: 'error' });
            setImportedProfile(null);
          }
        }
      };
      reader.readAsText(file);
    }
    e.target.value = '';
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
        <DialogTitle sx={{ pb: 0 }}>
          <Typography variant="h5" sx={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 1 }}>
            <FaceRetouchingNaturalIcon color="primary" /> Profile
          </Typography>
          <Tabs
            value={tabIndex}
            onChange={(_, v) => setTabIndex(v)}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
            sx={{
              mt: 1,
              '& .MuiTabs-scrollButtons': {
                width: 28,
              },
            }}
          >
            <Tab label="Avatar & Backdrop" icon={<FaceRetouchingNaturalIcon fontSize="small" />} iconPosition="start" />
            <Tab label="Identity" icon={<AccountCircleIcon fontSize="small" />} iconPosition="start" />
            <Tab label="Backup & Restore" icon={<DownloadIcon fontSize="small" />} iconPosition="start" />
          </Tabs>
        </DialogTitle>

        <DialogContent dividers sx={{ minHeight: 460 }}>
          {/* TAB 0: Avatar & Comic Setting */}
          {tabIndex === 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 0.5 }}>
              <Alert severity="info" sx={{ py: 0.5 }}>
                Choose your avatar character and pick your comic strip backdrop.
              </Alert>

              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                  {/* Selected Avatar Column */}
                  <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <Typography variant="caption" sx={{ fontWeight: 800, color: 'text.secondary', mb: 0.5 }}>
                      Selected Avatar:
                    </Typography>
                    <SelectedAvatarPreview name={selectedAvatar} avatarManager={avatarManager} />
                  </Box>

                  {/* Avatar Blurb */}
                  <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 130, lineHeight: 1.3, display: { xs: 'none', sm: 'block' } }}>
                    Your avatar represents you in every generated comic strip panel.
                  </Typography>

                  {/* Thin Vertical Divider */}
                  <Divider orientation="vertical" flexItem sx={{ my: 0.5, mx: 0.5, display: { xs: 'none', sm: 'block' } }} />

                  {/* Selected Backdrop Column */}
                  <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <Typography variant="caption" sx={{ fontWeight: 800, color: 'text.secondary', mb: 0.5 }}>
                      Selected Backdrop:
                    </Typography>
                    <SelectedBackdropPreview filename={selectedBackdrop} avatarManager={avatarManager} />
                  </Box>

                  {/* Backdrop Blurb & Selector Column */}
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, maxWidth: 195 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.35, display: { xs: 'none', md: 'block' } }}>
                      Your default backdrop is the comic panel background that will be used.
                    </Typography>

                    <FormControl size="small" fullWidth>
                      <InputLabel id="backdrop-select-label">Default Backdrop</InputLabel>
                      <Select
                        labelId="backdrop-select-label"
                        value={selectedBackdrop}
                        label="Default Backdrop"
                        onChange={(e) => setSelectedBackdrop(e.target.value)}
                      >
                        {AvatarManager.AVAILABLE_BACKDROPS.map((b) => (
                          <MenuItem key={b.filename} value={b.filename}>
                            {b.name}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Box>
                </Box>

                <Button
                  variant="contained"
                  color="primary"
                  startIcon={<SaveIcon />}
                  onClick={handleSaveProfile}
                  sx={{ height: 42, px: 2.5, fontWeight: 700, whiteSpace: 'nowrap' }}
                >
                  Save
                </Button>
              </Box>

              {/* Character Gallery Grid */}
              <Box
                sx={{
                  maxHeight: 310,
                  overflowY: 'auto',
                  p: 1,
                  borderRadius: 2,
                  bgcolor: 'background.default',
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Grid container spacing={1.5}>
                  {AvatarManager.AVAILABLE_AVATARS.map((av) => (
                    <Grid key={av.id} size={{ xs: 4, sm: 3, md: 2.4 }}>
                      <AvatarCardItem
                        name={av.name}
                        filename={av.filename}
                        isSelected={selectedAvatar.toLowerCase() === av.name.toLowerCase()}
                        onSelect={() => setSelectedAvatar(av.name)}
                        avatarManager={avatarManager}
                      />
                    </Grid>
                  ))}
                </Grid>
              </Box>
            </Box>
          )}

          {/* TAB 1: Identity */}
          {tabIndex === 1 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: 1 }}>
              <Alert severity="info" sx={{ py: 0.5 }}>
                Your screen name and optional biography/information are shared with participants in your encrypted channel.
              </Alert>

              <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
                <TextField
                  label="Screen Name"
                  value={screenName}
                  onChange={(e) => setScreenName(e.target.value)}
                  fullWidth
                  helperText="Appears as your character's name in comic strips and chat."
                  required
                />
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={<SaveIcon />}
                  onClick={handleSaveProfile}
                  sx={{ height: 42, px: 2.5, fontWeight: 700, whiteSpace: 'nowrap', mt: '7px' }}
                >
                  Save
                </Button>
              </Box>

              <Typography variant="subtitle2" color="primary" sx={{ fontWeight: 600, mt: 1 }}>
                OPTIONAL INFORMATION & BIOGRAPHY
              </Typography>

              <TextField
                label="Information / Biography"
                value={info}
                onChange={(e) => setInfo(e.target.value)}
                fullWidth
                multiline
                rows={5}
                placeholder="Write a biography, notes, interests, links, or other info about yourself..."
                helperText="Optional. Anyone in your conversation can view this when viewing your participant card."
              />
            </Box>
          )}

          {/* TAB 2: Backup & Restore */}
          {tabIndex === 2 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: 1 }}>
              <Alert severity="info" sx={{ py: 0.5 }}>
                Export or import your user profile, favorite rooms, open rooms, and friend list to transfer between devices. Saved/cached messages are excluded to provide a fresh start.
              </Alert>

              <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                <Button variant="contained" color="primary" startIcon={<DownloadIcon />} onClick={handleExportJson}>
                  Export File
                </Button>
                <Button variant="outlined" component="label" startIcon={<UploadFileIcon />}>
                  Import File
                  <input type="file" accept=".json" hidden onChange={handleFileUpload} />
                </Button>
              </Box>

              {importedProfile && (
                <>
                  <Divider sx={{ my: 0.5 }} />

                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    Backup Details
                  </Typography>

                  <Box
                    sx={{
                      p: 2,
                      bgcolor: 'background.default',
                      borderRadius: 2,
                      border: '1px solid',
                      borderColor: 'divider',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 1.5,
                    }}
                  >
                    <Box>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block' }}>
                        Screen Name
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>
                        {importedProfile.screenName}
                      </Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block' }}>
                        Participant ID
                      </Typography>
                      <Typography
                        variant="body2"
                        sx={{
                          fontFamily: 'monospace',
                          wordBreak: 'break-all',
                          fontSize: '0.8rem',
                          color: 'secondary.main',
                        }}
                      >
                        {importedProfile.participantId}
                      </Typography>
                    </Box>
                    {importedProfile.info && (
                      <Box>
                        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block' }}>
                          Info / Biography
                        </Typography>
                        <Typography variant="body2">
                          {importedProfile.info}
                        </Typography>
                      </Box>
                    )}
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 0.5 }}>
                      <Chip
                        size="small"
                        color="primary"
                        variant="outlined"
                        label={`${importedProfile.currentRoomsCount ?? 0} Current Rooms`}
                      />
                      <Chip
                        size="small"
                        color="secondary"
                        variant="outlined"
                        label={`${importedProfile.favoriteRoomsCount ?? 0} Favorite Rooms`}
                      />
                      <Chip
                        size="small"
                        color="info"
                        variant="outlined"
                        label={`${importedProfile.friendsCount ?? 0} Friends`}
                      />
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block' }}>
                        Exported / Created
                      </Typography>
                      <Typography variant="body2">
                        {importedProfile.created}
                      </Typography>
                    </Box>
                  </Box>

                  <Alert severity="warning" sx={{ py: 0.5 }}>
                    Restoring will clear all cached messages and conversations, reconstruct your user profile, favorite rooms, open rooms, and friend list as a blank slate, and allow you to pick right up with new messages.
                  </Alert>

                  <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                    <Button
                      variant="contained"
                      color="primary"
                      onClick={handleImportJson}
                    >
                      Restore (Clear &amp; Load)
                    </Button>
                    <Button
                      variant="outlined"
                      color="inherit"
                      onClick={handleClearImport}
                    >
                      Clear Import
                    </Button>
                  </Box>
                </>
              )}
            </Box>
          )}
        </DialogContent>

        <DialogActions sx={{ p: 2 }}>
          <Button onClick={onClose} variant="outlined">
            Close
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(snack)}
        autoHideDuration={4000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={snack?.severity || 'info'} onClose={() => setSnack(null)}>
          {snack?.message}
        </Alert>
      </Snackbar>
    </>
  );
};
