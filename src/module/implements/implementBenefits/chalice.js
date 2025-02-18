import { chaliceParagonDecrement, createEffectsOnActors } from "../../socket";
import {
  CHALICE_ADEPT_ENABLED_UUID,
  CHALICE_DRAINED_EFFECT_UUID,
  CHALICE_INTENSIFY_ENABLED_UUID,
  CHALICE_SIP_EFFECT_UUID,
  INTENSIFY_VULNERABILITY_CHALICE_EFFECT_UUID,
} from "../../utils";
import {
  createEffectData,
  getEffectOnActor,
  hasFeat,
  isThaumaturge,
} from "../../utils/helpers";
import { Implement } from "../implement";

class Chalice extends Implement {
  static intensifyEffectUuid = INTENSIFY_VULNERABILITY_CHALICE_EFFECT_UUID;

  constructor(actor, implementItem) {
    const chaliceRules = [];
    super(actor, implementItem, chaliceRules, "chalice");
  }

  get chaliceValues() {
    const baseSip =
      this.adept && this.targetValidAdeptBonus
        ? 2 + this.actor.system.abilities.cha.mod + this.actor.level
        : 2 + Math.floor(this.actor.level / 2);
    const baseDrain =
      this.adept && this.targetValidAdeptBonus
        ? 5 * this.actor.level
        : 3 * this.actor.level;

    const intensifySip = this.intensifyEnabled
      ? Math.floor(this.actor.level / 2)
      : 0;
    const intensifyDrain = this.intensifyEnabled ? this.actor.level : 0;

    return {
      sip: baseSip + intensifySip,
      drain: baseDrain + intensifyDrain,
    };
  }

  get intensifyEnabled() {
    return this.actor.itemTypes.effect.some(
      (e) => e.sourceId === CHALICE_INTENSIFY_ENABLED_UUID
    );
  }

  get targetValidAdeptBonus() {
    const target = Array.from(game.user.targets)[0]?.actor ?? this.actor;
    return target.itemTypes.effect.some(
      (i) => i.sourceId === CHALICE_ADEPT_ENABLED_UUID
    );
  }

  drink() {
    if (
      !isThaumaturge(this.actor) &&
      !hasFeat(this.actor, "implement-initiate")
    )
      return;
    const drainedEffect = getEffectOnActor(
      this.actor,
      CHALICE_DRAINED_EFFECT_UUID
    );

    let dgButtons = {
      sip: {
        label: "Sip",
        callback: () => this.sip(),
      },
    };

    let dgContent = game.i18n.localize(
      "pf2e-thaum-vuln.implements.chalice.drink.dialog.choose"
    );
    if (!drainedEffect || drainedEffect?.remainingDuration.expired === true) {
      dgButtons = {
        ...dgButtons,
        drain: {
          label: "Drain",
          callback: () => this.drain(),
        },
      };
    } else {
      dgContent =
        dgContent +
        "<br><br>" +
        game.i18n.localize(
          "pf2e-thaum-vuln.implements.chalice.drink.dialog.cooldown"
        ) +
        drainedEffect.system.remaining;
    }

    new Dialog({
      title: game.i18n.localize(
        "pf2e-thaum-vuln.implements.chalice.drink.dialog.title"
      ),
      content: dgContent,
      buttons: dgButtons,
    }).render(true);
  }

  async sip() {
    // If the drained chalice effect exists, reset the timer to 10 minutes.
    const drainedEffect = getEffectOnActor(
      this.actor,
      CHALICE_DRAINED_EFFECT_UUID
    );

    if (drainedEffect) {
      const initiative = game.combat?.combatant?.initiative;
      await drainedEffect.update({
        _id: drainedEffect._id,
        "system.start": { value: game.time.worldTime, initiative: initiative },
      });
    }

    const targetArray = Array.from(game.user.targets).map((t) => {
      return t.id;
    });

    createEffectsOnActors(
      this.actor.id,
      targetArray,
      [CHALICE_SIP_EFFECT_UUID],
      { max: 1, applyOnNoTargets: "self" }
    );
  }

  async drain() {
    const DamageRoll = CONFIG.Dice.rolls.find((r) => r.name === "DamageRoll");
    const targetArray = Array.from(game.user.targets);
    const primaryTarget =
      targetArray.length > 0 ? targetArray[0].actor : this.actor;
    const healingType = Array.from(primaryTarget.traits).some(
      (t) => t === "undead"
    )
      ? "void"
      : "vitality";
    new DamageRoll(
      `{(${this.chaliceValues.drain})[healing,${healingType}]}`
    ).toMessage();
    this.actor.createEmbeddedDocuments("Item", [
      await createEffectData(CHALICE_DRAINED_EFFECT_UUID),
    ]);

    if (this.paragon) {
      chaliceParagonDecrement(primaryTarget.id);
    }
    if (primaryTarget.itemTypes.condition?.find((c) => c.slug === "stunned")) {
      ChatMessage.create({
        user: game.user,
        flavor: game.i18n.localize(
          "pf2e-thaum-vuln.implements.chalice.drink.chat.reduceStunned"
        ),
      });

      ChatMessage.create({
        user: game.user,
        flavor:
          game.i18n.localize(
            "pf2e-thaum-vuln.implements.chalice.drink.chat.counteract"
          ) +
          `<br><br> [[/r 1d20+${
            this.actor.attributes.classDC.value - 10
          } #Counteract]] ${game.i18n.localize(
            "pf2e-thaum-vuln.implements.chalice.drink.chat.counteractLevel"
          )} ${Math.ceil(this.actor.level / 2)}`,
      });
    }
  }
}

Hooks.once("init", () => {
  //Check chat for Adept benefit increased healing
  Hooks.on("preCreateChatMessage", async (message) => {
    if (!game.ready || !game.user.isGM || !game.combats.active) return;

    const damageTypes = [];
    message.rolls?.forEach((r) => {
      r.options?.damage?.damage.base.forEach((d) =>
        damageTypes.push(d.damageType)
      );
    });
    const isValidChaliceStrike =
      (damageTypes.includes("slashing") || damageTypes.includes("piercing")) &&
      message.flags.pf2e.context?.outcome === "criticalSuccess"
        ? true
        : false;
    if (
      !isValidChaliceStrike &&
      !message.rolls[0]?.options.evaluatePersistent &&
      !message.rolls[0]?.instances?.some((i) => i.type === "bleed")
    ) {
      return;
    }
    const thaumTokens = game.canvas.tokens.placeables.filter(
      (t) => t.actor.attributes?.implements?.chalice?.adept
    );

    for (const thaum of thaumTokens) {
      const targetTokens = Object.fromEntries(
        message.flags["pf2e-thaum-vuln"].targets.map((t) => {
          const token = game.canvas.tokens.get(t.id);
          return [
            thaum.id,
            {
              token: token.actor?.alliance === "party" ? token : undefined,
              thaum: thaum,
              distance: thaum.distanceTo(token),
            },
          ];
        })
      );

      const hasChaliceEnabled =
        targetTokens[thaum.id].token.actor.itemTypes.effect.find(
          (e) => e.sourceId === CHALICE_ADEPT_ENABLED_UUID
        )?.system.expired === false;

      if (
        !hasChaliceEnabled &&
        targetTokens[thaum.id].token &&
        targetTokens[thaum.id].distance <= 30
      ) {
        await createEffectsOnActors(
          thaum.actor.id,
          [targetTokens[thaum.id].token.id],
          [CHALICE_ADEPT_ENABLED_UUID],
          { max: 1 }
        );
      }
    }
  });

  //Check chat for intensify vulnerability increased healing
  Hooks.on("preCreateChatMessage", async (message) => {
    if (
      !game.ready ||
      !game.user.isGM ||
      !game.combats.active ||
      !message.actor?.attributes?.implements?.chalice?.intensified
    )
      return;

    const targetTokens = message.flags["pf2e-thaum-vuln"].targets.map((t) => {
      return t.actorUuid;
    });

    if (
      targetTokens.includes(
        message.actor.getFlag("pf2e-thaum-vuln", "primaryEVTarget")
      ) &&
      message.flags.pf2e?.context?.action === "strike" &&
      ["success", "criticalSuccess"].includes(
        message.flags.pf2e?.context?.outcome
      )
    ) {
      message.actor.createEmbeddedDocuments("Item", [
        await createEffectData(CHALICE_INTENSIFY_ENABLED_UUID),
      ]);
    }
  });
});

export { Chalice };
