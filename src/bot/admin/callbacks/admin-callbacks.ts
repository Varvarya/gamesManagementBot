export const AdminCallbacks = {
    MainMenu: 'admin:main',

    Schedule: 'admin:schedule',
    ActiveTrainings: 'admin:active_trainings',
    Players: 'admin:players',
    Settings: 'admin:settings',

    CreateTemplate: 'admin:template:create',
    ConfirmCreateTemplate:
        'admin:template:create:confirm',
    CancelCreateTemplate:
        'admin:template:create:cancel',

    ConfirmEditTemplate:
        'admin:template:edit:confirm',
    CancelEditTemplate:
        'admin:template:edit:cancel',

    TemplatePrefix: 'admin:template:',
    TemplateEditPrefix: 'admin:template:edit:',
    TemplateTogglePrefix: 'admin:template:toggle:',
    TemplateDeletePrefix: 'admin:template:delete:',
    TemplateDeleteConfirmPrefix:
        'admin:template:delete_confirm:',

    UnconfirmedPlayers:
        'admin:players:unconfirmed',
    AllPlayers: 'admin:players:all',

    CreatePlayer: 'admin:player:create',
    PlayerPrefix: 'admin:player:',

    TrainingPrefix: 'admin:training:',
    TrainingClosePrefix: 'admin:training:close:',
    TrainingOpenPrefix: 'admin:training:open:',
    TrainingCancelPrefix: 'admin:training:cancel:',
    TrainingCancelConfirmPrefix:
        'admin:training:cancel_confirm:',
    TrainingRefreshPrefix:
        'admin:training:refresh:',

    TrainingAddPlayerPrefix:
        'admin:training:add_player:',
    TrainingRemovePlayerPrefix:
        'admin:training:remove_player:',

    TrainingSelectAddPlayerPrefix:
        'admin:training:select_add_player:',
    TrainingSelectRemovePlayerPrefix:
        'admin:training:select_remove_player:',

    SettingsCancelHours:
        'admin:settings:cancel_hours',
    SettingsToggleCleanChat:
        'admin:settings:toggle_clean_chat',
} as const;