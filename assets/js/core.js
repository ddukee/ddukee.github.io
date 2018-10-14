// tagcloud init
(function ($) {
    $.fn.tagcloud = function (options) {
        var opts = $.extend({}, $.fn.tagcloud.defaults, options);
        tagWeights = this.map(function () {
            return $(this).attr("rel");
        })
        tagWeights = jQuery.makeArray(tagWeights).sort(compareWeights);
        lowest = tagWeights[0];
        highest = tagWeights.pop();
        range = highest - lowest;
        // Sizes
        if (opts.size) {
            fontIncr = (opts.size.end - opts.size.start) / range;
        }
        // colors
        if (opts.color) {
            colorIncr = colorIncrement(opts.color, range);
        }
        return this.each(function () {
            weighting = $(this).attr("rel") - lowest;
            if (opts.size) {
                $(this).css({
                    "font-size": opts.size.start + (weighting * fontIncr) + opts.size.unit
                });
            }
            if (opts.color) {
                $(this).css({
                    "color": tagColor(opts.color, colorIncr, weighting)
                });
            }
        })
    }

    $.fn.tagcloud.defaults = {
        size: {
            start: 20,
            end: 30,
            unit: "px"
        },
        color: {
            start: '#ffd8d8',
            end: '#dd0000'
        }
    };

    // Converts hex to an RGB array
    function toRGB(code) {
        if (code.length == 4) {
            code = jQuery.map(/\w+/.exec(code), function (el) {
                return el + el;
            }).join("");
        }
        hex = /(\w{2})(\w{2})(\w{2})/.exec(code);
        return [parseInt("0x" + hex[1]), parseInt("0x" + hex[2]), parseInt("0x" + hex[3])];
    }

    // Converts an RGB array to hex
    function toHex(ary) {
        return "#" + jQuery.map(ary, function (int) {
            hex = int.toString(16);
            hex = (hex.length == 1) ? "0" + hex : hex;
            return hex;
        }).join("");
    }

    function colorIncrement(color, range) {
        return jQuery.map(toRGB(color.end), function (int, i) {
            return (int - toRGB(color.start)[i]) / range;
        });
    }

    function tagColor(color, increment, weighting) {
        rgb = jQuery.map(toRGB(color.start), function (int, i) {
            ref = Math.round(int + (increment[i] * weighting));
            if (ref > 255) {
                ref = 255;
            } else {
                if (ref < 0) {
                    ref = 0;
                }
            }
            return ref;
        });
        return toHex(rgb);
    }

    function compareWeights(a, b) {
        return a - b;
    }
})(jQuery);

function renderTimeSpan() {
  var date = new Date();
  var year = date.getFullYear().toString();
  var month = (date.getMonth() + 1).toString();
  var day = date.getDate().toString();
  var hour = date.getHours().toString();
  var min = date.getMinutes().toString();
  var sec = date.getSeconds().toString();
  
  month.length < 2 && (month = '0' + month);
  day.length < 2 && (day = '0' + day);
  hour.length < 2 && (hour = '0' + hour);
  min.length < 2 && (min = '0' + min);
  sec.length < 2 && (sec = '0' + sec);
  
  $("#timeSpan").html(year + "-" + month + "-" + day + " " + hour + ":" + min + ":" + sec);
}

function renderCopyright() {
  var year = new Date().getFullYear();
  $("#copyright").html("2017 - " + year + " ");
}

function renderTagCloud() {
  $("#tagcloud a").tagcloud({size: {start: 14, end: 14, unit: "px"}, color: {start: "#ffd8d8", end: "#dd0000"}})
}

$(function() {
  renderCopyright();
  renderTimeSpan();
  renderTagCloud();
  setInterval(renderTimeSpan, 1000);
})