import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
} from 'discord.js';
import {
  COMMAND_EMBED_COLOR,
  buildStatusEmbed,
  checkBotVoicePermissions,
  enforceCommandGuards,
  formatMissingVoicePermissionsMessage,
  replyEphemeral,
  resolveVoiceChannel,
} from './guards.js';
import type { CommandContext, SlashCommand } from './types.js';

async function handleViewConfig(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
  guildId: string,
): Promise<void> {
  const settings = context.settingsRepo.getOrDefault(guildId);
  const channel247Value = settings.voiceChannelId247
    ? `<#${settings.voiceChannelId247}>${settings.textChannelId247 ? ` (avisos em <#${settings.textChannelId247}>)` : ''}`
    : 'Nenhum';

  const embed = new EmbedBuilder()
    .setColor(COMMAND_EMBED_COLOR)
    .setTitle('⚙️ Configurações do Servidor')
    .addFields(
      { name: 'Volume padrão', value: `${settings.defaultVolume}%`, inline: true },
      {
        name: 'Cargo DJ',
        value: settings.djRoleId ? `<@&${settings.djRoleId}>` : 'Nenhum (livre)',
        inline: true,
      },
      {
        name: 'Canal de música',
        value: settings.musicChannelId ? `<#${settings.musicChannelId}>` : 'Todos os canais',
        inline: true,
      },
      { name: 'Auto-saída', value: `${settings.autoLeaveSeconds} segundos`, inline: true },
      {
        name: 'Modo 24/7',
        value: settings.alwaysOn247 ? 'Ativado' : 'Desativado',
        inline: true,
      },
      { name: 'Canal 24/7', value: channel247Value, inline: true },
    );

  await interaction.reply({ embeds: [embed] });
}

async function handleModo247(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
  guild: Guild,
  guildId: string,
  member: GuildMember,
): Promise<void> {
  const enabled = interaction.options.getBoolean('ativado', true);

  if (!enabled) {
    context.settingsRepo.update(guildId, {
      alwaysOn247: false,
      voiceChannelId247: null,
      textChannelId247: null,
    });
    await context.musicService.handle247Disabled(guildId);
    await interaction.reply({
      embeds: [
        buildStatusEmbed(
          '🌙 Modo 24/7 Desativado',
          'Modo 24/7 **desativado**. O bot voltará a sair automaticamente quando ocioso ou sozinho no canal de voz.',
        ),
      ],
    });
    return;
  }

  const botMember = guild.members?.me ?? null;
  const botVoice = resolveVoiceChannel(guild, botMember?.voice);
  const memberVoice = resolveVoiceChannel(guild, member.voice);

  const targetChannelId = botVoice.channelId ?? memberVoice.channelId;
  const targetChannel = botVoice.channel ?? memberVoice.channel;

  if (!targetChannelId) {
    await replyEphemeral(
      interaction,
      'Para ativar o modo 24/7, entre em um canal de voz ou conecte o bot em um canal primeiro.',
    );
    return;
  }

  const permsCheck = checkBotVoicePermissions(targetChannel, botMember);
  if (!permsCheck.ok) {
    await replyEphemeral(
      interaction,
      formatMissingVoicePermissionsMessage(targetChannelId, permsCheck),
    );
    return;
  }

  context.settingsRepo.update(guildId, {
    alwaysOn247: true,
    voiceChannelId247: targetChannelId,
    textChannelId247: interaction.channelId,
  });

  const connectResult = await context.musicService.ensureConnected247(
    guildId,
    targetChannelId,
    interaction.channelId,
  );

  if (!connectResult.ok) {
    await replyEphemeral(
      interaction,
      `⚠️ Modo 24/7 salvo para <#${targetChannelId}>, porém: ${connectResult.message}`,
    );
    return;
  }

  await interaction.reply({
    embeds: [
      buildStatusEmbed(
        '🌙 Modo 24/7 Ativado',
        `Modo 24/7 **ativado** para o canal <#${targetChannelId}>.`,
      ),
    ],
  });
}

export const configCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configura as opções de música do servidor')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub.setName('ver').setDescription('Visualiza as configurações atuais do servidor'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('volume')
        .setDescription('Define o volume padrão inicial ao criar o player')
        .addIntegerOption((opt) =>
          opt
            .setName('nivel')
            .setDescription('Volume padrão inicial (1 a 150)')
            .setMinValue(1)
            .setMaxValue(150)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('dj')
        .setDescription('Define ou remove o cargo de DJ do servidor')
        .addRoleOption((opt) =>
          opt
            .setName('cargo')
            .setDescription('Cargo de DJ (omita para remover a restrição)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('canal')
        .setDescription('Restringe comandos musicais a um canal de texto ou libera todos')
        .addChannelOption((opt) =>
          opt
            .setName('canal_texto')
            .setDescription('Canal de texto permitido (omita para liberar todos os canais)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('autosaida')
        .setDescription('Define o tempo de espera antes de sair quando ocioso ou vazio')
        .addIntegerOption((opt) =>
          opt
            .setName('segundos')
            .setDescription('Tempo em segundos (30 a 1800)')
            .setMinValue(30)
            .setMaxValue(1800)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('modo247')
        .setDescription('Ativa ou desativa o modo 24/7 no servidor')
        .addBooleanOption((opt) =>
          opt
            .setName('ativado')
            .setDescription('Ativar ou desativar o modo 24/7')
            .setRequired(true),
        ),
    ),

  async execute(interaction, context) {
    const guard = await enforceCommandGuards(interaction, context, {
      enforceMusicChannel: false,
      requireVoice: false,
      requireControl: false,
      requireManageGuild: true,
    });
    if (!guard.ok) {
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'ver':
        await handleViewConfig(interaction, context, guard.guildId);
        return;

      case 'volume': {
        const level = interaction.options.getInteger('nivel', true);
        context.settingsRepo.update(guard.guildId, { defaultVolume: level });
        await interaction.reply({
          embeds: [
            buildStatusEmbed(
              '⚙️ Volume Padrão Atualizado',
              `Volume padrão inicial definido para **${level}%**.`,
            ),
          ],
        });
        return;
      }

      case 'dj': {
        const role = interaction.options.getRole('cargo');
        context.settingsRepo.update(guard.guildId, { djRoleId: role?.id ?? null });
        const description = role
          ? `Cargo de DJ definido para <@&${role.id}>.`
          : 'Restrição de cargo de DJ removida. Todos no canal podem controlar o player.';
        await interaction.reply({
          embeds: [buildStatusEmbed('⚙️ Cargo DJ Atualizado', description)],
        });
        return;
      }

      case 'canal': {
        const channel = interaction.options.getChannel('canal_texto');
        context.settingsRepo.update(guard.guildId, { musicChannelId: channel?.id ?? null });
        const description = channel
          ? `Comandos musicais restritos ao canal <#${channel.id}>.`
          : 'Restrição de canal removida. Comandos musicais liberados em todos os canais.';
        await interaction.reply({
          embeds: [buildStatusEmbed('⚙️ Canal de Música Atualizado', description)],
        });
        return;
      }

      case 'autosaida': {
        const seconds = interaction.options.getInteger('segundos', true);
        context.settingsRepo.update(guard.guildId, { autoLeaveSeconds: seconds });
        await interaction.reply({
          embeds: [
            buildStatusEmbed(
              '⚙️ Tempo de Auto-Saída Atualizado',
              `Tempo de espera para sair quando ocioso/vazio definido para **${seconds}** segundos.`,
            ),
          ],
        });
        return;
      }

      case 'modo247':
        await handleModo247(interaction, context, guard.guild, guard.guildId, guard.member);
        return;

      default:
        await replyEphemeral(interaction, 'Subcomando de configuração desconhecido.');
    }
  },
};
