import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Box,
  Alert,
  CircularProgress,
  Chip,
  MenuItem,
  FormControl,
  InputLabel,
  Select,
} from '@mui/material';
import PublicIcon from '@mui/icons-material/Public';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import { useChat } from '../context/ChatContext';
import { getRandomChannelTitle } from '../utils/channelNameGenerator';

interface CreatePublicRoomDialogProps {
  open: boolean;
  onClose: () => void;
}

const POPULAR_TAGS = ['general', 'comics', 'retro', 'gaming', 'art', 'hangout', 'tech', 'music'];

export const CreatePublicRoomDialog: React.FC<CreatePublicRoomDialogProps> = ({ open, onClose }) => {
  const { createPublicRoom } = useChat();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [language, setLanguage] = useState('en');
  const [selectedTags, setSelectedTags] = useState<string[]>(['general']);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(getRandomChannelTitle());
      setDescription('');
      setTagsInput('');
      setSelectedTags(['general']);
      setError(null);
    }
  }, [open]);

  const handleToggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Please provide a room name.');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const extraTags = tagsInput
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0);
      const combinedTags = Array.from(new Set([...selectedTags, ...extraTags]));

      await createPublicRoom(name.trim(), description.trim(), combinedTags, language);
      onClose();
    } catch (err: any) {
      console.error('Failed to create public room:', err);
      setError(err?.message || 'Failed to publish public room to the directory.');
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <PublicIcon color="primary" />
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          Create Public Room
        </Typography>
      </DialogTitle>

      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Alert severity="info" sx={{ py: 0.5 }}>
          🌐 <strong>Public Directory Notice</strong>: Public rooms are published to the public directory and can be discovered by anyone. No invitation link or member approval is required to join.
        </Alert>

        {error && (
          <Alert severity="error" sx={{ py: 0.5 }}>
            {error}
          </Alert>
        )}

        <TextField
          label="Room Name"
          placeholder="e.g. Comic Creators Lounge"
          value={name}
          onChange={(e) => setName(e.target.value)}
          fullWidth
          required
          autoFocus
          disabled={isCreating}
          helperText="Max 80 characters"
          slotProps={{
            htmlInput: { maxLength: 80 }
          }}
        />

        <TextField
          label="Description (Optional)"
          placeholder="What is this room about?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          fullWidth
          multiline
          rows={3}
          disabled={isCreating}
          helperText="Max 500 characters"
          slotProps={{
            htmlInput: { maxLength: 500 }
          }}
        />

        <FormControl fullWidth size="small">
          <InputLabel id="pub-room-lang-label">Language</InputLabel>
          <Select
            labelId="pub-room-lang-label"
            value={language}
            label="Language"
            onChange={(e) => setLanguage(e.target.value)}
            disabled={isCreating}
          >
            <MenuItem value="en">English (en)</MenuItem>
            <MenuItem value="es">Español (es)</MenuItem>
            <MenuItem value="ja">日本語 (ja)</MenuItem>
            <MenuItem value="fr">Français (fr)</MenuItem>
            <MenuItem value="de">Deutsch (de)</MenuItem>
            <MenuItem value="any">Any / Multilingual</MenuItem>
          </Select>
        </FormControl>

        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 1 }}>
            TOPIC TAGS
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.8, mb: 1.5 }}>
            {POPULAR_TAGS.map((tag) => {
              const active = selectedTags.includes(tag);
              return (
                <Chip
                  key={tag}
                  label={`#${tag}`}
                  clickable
                  color={active ? 'primary' : 'default'}
                  variant={active ? 'filled' : 'outlined'}
                  size="small"
                  onClick={() => handleToggleTag(tag)}
                  disabled={isCreating}
                />
              );
            })}
          </Box>

          <TextField
            label="Additional Custom Tags (comma-separated)"
            placeholder="e.g. anime, sketch, indie"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            fullWidth
            size="small"
            disabled={isCreating}
          />
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} disabled={isCreating} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={handleCreate}
          variant="contained"
          color="primary"
          startIcon={isCreating ? <CircularProgress size={18} color="inherit" /> : <AddCircleOutlineIcon />}
          disabled={isCreating || !name.trim()}
        >
          {isCreating ? 'Publishing to Directory...' : 'Create & Enter Room'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
